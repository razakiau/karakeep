import fs from "fs";
import { readdir, readFile } from "fs/promises";
import * as os from "os";
import path from "path";
import { eq } from "drizzle-orm";
import { execa } from "execa";
import { workerStatsCounter } from "metrics";
import {
  getProxyAgent,
  resolveValidatedRedirectUrl,
  selectRunProxies,
} from "network";
import type { RunProxyConfig } from "network";
import { withWorkerEventLog, withWorkerTracing } from "workerTracing";

import { db } from "@karakeep/db";
import { assets, AssetTypes, bookmarkLinks } from "@karakeep/db/schema";
import {
  addLogFields,
  OpenAIQueue,
  QueuePriority,
  QuotaService,
  StorageQuotaError,
  storeHtmlContent,
  triggerSearchReindex,
  VideoWorkerQueue,
  ZVideoRequest,
  zvideoRequestSchema,
} from "@karakeep/shared-server";
import { WebhooksService } from "@karakeep/trpc/models/webhooks.service";
import {
  ASSET_TYPES,
  newAssetId,
  saveAssetFromFile,
  silentDeleteAsset,
} from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { DequeuedJob, getQueueClient } from "@karakeep/shared/queueing";

import { getBookmarkDetails, updateAsset } from "../workerUtils";
import { parseVttToHtml } from "./vttParser";

const TMP_FOLDER = path.join(os.tmpdir(), "video_downloads");

export class VideoWorker {
  static async build() {
    logger.info("Starting video worker ...");

    return (await getQueueClient())!.createRunner<ZVideoRequest>(
      VideoWorkerQueue,
      {
        run: withWorkerTracing(
          "videoWorker.run",
          withWorkerEventLog("videoWorker.run", runWorker),
        ),
        onComplete: async (job) => {
          workerStatsCounter.labels("video", "completed").inc();
          const jobId = job.id;
          logger.info(
            `[VideoCrawler][${jobId}] Video Download Completed successfully`,
          );
          return Promise.resolve();
        },
        onError: async (job) => {
          workerStatsCounter.labels("video", "failed").inc();
          if (job.numRetriesLeft == 0) {
            workerStatsCounter.labels("video", "failed_permanent").inc();
          }
          const jobId = job.id;
          logger.error(
            `[VideoCrawler][${jobId}] Video Download job failed: ${job.error}`,
          );
          return Promise.resolve();
        },
      },
      {
        pollIntervalMs: 1000,
        timeoutSecs: serverConfig.crawler.downloadVideoTimeout,
        concurrency: 1,
        validator: zvideoRequestSchema,
      },
    );
  }
}

function prepareYtDlpArguments(
  url: string,
  proxy: string | undefined,
  assetPath: string,
) {
  // yt-dlp performs its own HTTP requests and can follow redirects that this
  // process cannot validate. Full SSRF protection depends on an egress proxy or
  // network policy that blocks internal/private targets.
  const ytDlpArguments = [url];
  if (serverConfig.crawler.maxVideoDownloadSize > 0) {
    ytDlpArguments.push(
      "-f",
      `best[filesize<${serverConfig.crawler.maxVideoDownloadSize}M]`,
    );
  }

  ytDlpArguments.push(...serverConfig.crawler.ytDlpArguments);
  ytDlpArguments.push("-o", assetPath);
  ytDlpArguments.push("--no-playlist");
  if (proxy) {
    ytDlpArguments.push("--proxy", proxy);
  }
  return ytDlpArguments;
}

/**
 * Pulls subtitles for the video with yt-dlp and converts them to HTML.
 * Returns null when transcripts are disabled or the video has no subtitles.
 */
async function extractTranscript(
  url: string,
  tmpDir: string,
  jobId: string,
  runProxy: RunProxyConfig,
  abortSignal?: AbortSignal,
): Promise<string | null> {
  if (!serverConfig.crawler.extractTranscript) {
    return null;
  }

  const transcriptLangs = serverConfig.crawler.transcriptLangs;

  try {
    const proxy = getProxyAgent(url, runProxy);
    const args = [
      "--write-subs",
      "--write-auto-subs",
      "--ignore-errors",
      "--sub-lang",
      transcriptLangs,
      "--sub-format",
      "vtt",
      "--skip-download",
      "--no-playlist",
      "--output",
      `${tmpDir}/%(id)s`,
      url,
    ];
    if (proxy) {
      args.push("--proxy", proxy.proxy.toString());
    }

    try {
      await execa("yt-dlp", args, {
        cancelSignal: abortSignal,
      });
    } catch {
      // yt-dlp exits non-zero when only *some* subtitle languages fail (e.g.
      // HTTP 429), so don't give up yet — check for downloaded files below.
      abortSignal?.throwIfAborted();
    }

    const files = await readdir(tmpDir);
    const vttFiles = files.filter((f) => f.endsWith(".vtt"));
    if (vttFiles.length === 0) return null;

    // Prefer a VTT matching the configured language order.
    const langOrder = transcriptLangs.split(",").map((l) => l.trim());
    let selectedVtt = vttFiles[0];
    for (const lang of langOrder) {
      const match = vttFiles.find((f) => f.includes(`.${lang}.`));
      if (match) {
        selectedVtt = match;
        break;
      }
    }

    // yt-dlp derives the filename from the video id, so make sure a crafted id
    // can't write/read outside the temp dir.
    const vttPath = path.join(tmpDir, selectedVtt);
    const resolvedPath = await fs.promises.realpath(vttPath);
    const resolvedDir = await fs.promises.realpath(tmpDir);
    if (!resolvedPath.startsWith(resolvedDir + path.sep)) {
      logger.warn(
        `[VideoCrawler][${jobId}] VTT path traversal attempt detected: "${selectedVtt}"`,
      );
      return null;
    }

    const vttContent = await readFile(resolvedPath, "utf-8");
    return parseVttToHtml(vttContent);
  } catch {
    abortSignal?.throwIfAborted();
    logger.info(`[VideoCrawler][${jobId}] No subtitles available for "${url}"`);
    return null;
  }
}

/**
 * Saves the transcript as the bookmark's content and kicks off AI inference.
 * Content the user set by hand is never overwritten.
 */
async function storeTranscriptContent(
  bookmarkId: string,
  userId: string,
  transcript: string,
  jobId: string,
  normalizedUrl: string,
): Promise<void> {
  const existingLink = await db.query.bookmarkLinks.findFirst({
    where: eq(bookmarkLinks.id, bookmarkId),
    columns: { contentSource: true, contentAssetId: true },
  });

  if (existingLink?.contentSource === "manual") {
    logger.info(
      `[VideoCrawler][${jobId}] Skipping transcript: contentSource is manual`,
    );
    return;
  }

  const oldContentAssetId = existingLink?.contentAssetId ?? undefined;
  const storageResult = await storeHtmlContent(
    transcript,
    userId,
    jobId,
    "VideoCrawler",
  );

  if (storageResult.result === "stored") {
    await db.transaction(async (txn) => {
      await updateAsset(
        oldContentAssetId,
        {
          id: storageResult.assetId,
          bookmarkId,
          userId,
          assetType: AssetTypes.LINK_HTML_CONTENT,
          contentType: ASSET_TYPES.TEXT_HTML,
          size: storageResult.size,
          fileName: null,
        },
        txn,
      );
      await txn
        .update(bookmarkLinks)
        .set({
          htmlContent: null,
          contentAssetId: storageResult.assetId,
          contentSource: "transcript",
        })
        .where(eq(bookmarkLinks.id, bookmarkId));
    });
    if (oldContentAssetId) {
      await silentDeleteAsset(userId, oldContentAssetId);
    }
  } else if (storageResult.result === "store_inline") {
    await db.transaction(async (txn) => {
      if (oldContentAssetId) {
        await txn.delete(assets).where(eq(assets.id, oldContentAssetId));
      }
      await txn
        .update(bookmarkLinks)
        .set({
          htmlContent: transcript,
          contentAssetId: null,
          contentSource: "transcript",
        })
        .where(eq(bookmarkLinks.id, bookmarkId));
    });
    if (oldContentAssetId) {
      await silentDeleteAsset(userId, oldContentAssetId);
    }
  } else {
    // not_stored (quota exceeded or no content) — nothing to save.
    return;
  }

  await Promise.all([
    OpenAIQueue.enqueue(
      { bookmarkId, type: "summarize" },
      { priority: QueuePriority.Default, groupId: userId },
    ),
    OpenAIQueue.enqueue(
      { bookmarkId, type: "tag" },
      { priority: QueuePriority.Default, groupId: userId },
    ),
    triggerSearchReindex(bookmarkId, { groupId: userId }),
  ]);

  logger.info(
    `[VideoCrawler][${jobId}] Stored transcript for "${normalizedUrl}" and triggered AI inference`,
  );
}

async function runWorker(job: DequeuedJob<ZVideoRequest>) {
  const jobId = job.id;
  const { bookmarkId } = job.data;
  addLogFields<"videoWorker.run">({ "bookmark.id": bookmarkId });

  const {
    url,
    userId,
    videoAssetId: oldVideoAssetId,
  } = await getBookmarkDetails(bookmarkId);

  // URL validation guards both the download and the transcript fetch, so it
  // runs before the downloadVideo check.
  const runProxy = selectRunProxies();
  let normalizedUrl: string;
  try {
    const resolvedUrl = await resolveValidatedRedirectUrl(
      url,
      { signal: job.abortSignal },
      runProxy,
    );
    normalizedUrl = resolvedUrl.toString();
  } catch (error) {
    logger.warn(
      `[VideoCrawler][${jobId}] Skipping video worker for "${url}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const downloadResult = await downloadVideo(
    job,
    jobId,
    bookmarkId,
    userId,
    normalizedUrl,
    runProxy,
    oldVideoAssetId,
  );

  // If yt-dlp can't handle the URL at all, subtitles won't work either.
  if (downloadResult === "unsupported_url") {
    return;
  }

  await processTranscript(
    job,
    jobId,
    bookmarkId,
    userId,
    normalizedUrl,
    runProxy,
  );

  // Fired after all processing. Deliberately not in a finally block: we don't
  // want to emit for validation failures or unsupported URLs.
  if (!job.abortSignal.aborted) {
    const webhookService = new WebhooksService(db);
    await webhookService.triggerWebhook(bookmarkId, "video_processed", userId, {
      groupId: userId,
    });
  }
}

/**
 * Downloads the video and attaches it to the bookmark.
 *
 * Returns "unsupported_url" when yt-dlp can't handle the URL at all (in which
 * case subtitles won't work either). Every other failure returns "done", so
 * that transcript extraction still gets a chance to run.
 */
async function downloadVideo(
  job: DequeuedJob<ZVideoRequest>,
  jobId: string,
  bookmarkId: string,
  userId: string,
  normalizedUrl: string,
  runProxy: RunProxyConfig,
  oldVideoAssetId: string | undefined,
): Promise<"done" | "unsupported_url"> {
  if (!serverConfig.crawler.downloadVideo) {
    logger.info(
      `[VideoCrawler][${jobId}] Skipping video download from "${normalizedUrl}", because it is disabled in the config.`,
    );
    return "done";
  }

  const videoAssetId = newAssetId();
  let assetPath = `${TMP_FOLDER}/${videoAssetId}`;
  await fs.promises.mkdir(TMP_FOLDER, { recursive: true });

  const proxy = getProxyAgent(normalizedUrl, runProxy);
  const ytDlpArguments = prepareYtDlpArguments(
    normalizedUrl,
    proxy?.proxy.toString(),
    assetPath,
  );

  try {
    logger.info(
      `[VideoCrawler][${jobId}] Attempting to download a file from "${normalizedUrl}" to "${assetPath}" using the following arguments: "${ytDlpArguments}"`,
    );

    await execa("yt-dlp", ytDlpArguments, {
      cancelSignal: job.abortSignal,
    });
    const downloadPath = await findAssetFile(videoAssetId);
    if (!downloadPath) {
      logger.info(
        `[VideoCrawler][${jobId}] yt-dlp didn't download anything. Skipping ...`,
      );
      return "done";
    }
    assetPath = downloadPath;
  } catch (e) {
    await deleteLeftOverAssetFile(jobId, videoAssetId);
    job.abortSignal.throwIfAborted();

    const err = e as Error;
    if (
      err.message.includes("ERROR: Unsupported URL:") ||
      err.message.includes("No media found")
    ) {
      logger.info(
        `[VideoCrawler][${jobId}] Skipping video download from "${normalizedUrl}", because it's not one of the supported yt-dlp URLs`,
      );
      return "unsupported_url";
    }
    const genericError = `[VideoCrawler][${jobId}] Failed to download a file from "${normalizedUrl}" to "${assetPath}"`;
    if ("stderr" in err) {
      logger.error(`${genericError}: ${err.stderr}`);
    } else {
      logger.error(genericError);
    }
    return "done";
  }

  logger.info(
    `[VideoCrawler][${jobId}] Finished downloading a file from "${normalizedUrl}" to "${assetPath}"`,
  );

  // Get file size and check quota before saving
  const stats = await fs.promises.stat(assetPath);
  const fileSize = stats.size;

  try {
    const quotaApproved = await QuotaService.checkStorageQuota(
      db,
      userId,
      fileSize,
    );

    await saveAssetFromFile({
      userId,
      assetId: videoAssetId,
      assetPath,
      metadata: { contentType: ASSET_TYPES.VIDEO_MP4 },
      quotaApproved,
    });

    await db.transaction(async (txn) => {
      await updateAsset(
        oldVideoAssetId,
        {
          id: videoAssetId,
          bookmarkId,
          userId,
          assetType: AssetTypes.LINK_VIDEO,
          contentType: ASSET_TYPES.VIDEO_MP4,
          size: fileSize,
        },
        txn,
      );
    });
    await silentDeleteAsset(userId, oldVideoAssetId);

    logger.info(
      `[VideoCrawler][${jobId}] Finished downloading video from "${normalizedUrl}" and adding it to the database`,
    );
  } catch (error) {
    if (error instanceof StorageQuotaError) {
      logger.warn(
        `[VideoCrawler][${jobId}] Skipping video storage due to quota exceeded: ${error.message}`,
      );
      await deleteLeftOverAssetFile(jobId, videoAssetId);
      return "done";
    }
    throw error;
  }

  return "done";
}

/**
 * Extracts subtitles for the video and stores them as the bookmark's content.
 * Cleans up its temp directory regardless of outcome.
 */
async function processTranscript(
  job: DequeuedJob<ZVideoRequest>,
  jobId: string,
  bookmarkId: string,
  userId: string,
  normalizedUrl: string,
  runProxy: RunProxyConfig,
) {
  if (!serverConfig.crawler.extractTranscript) {
    return;
  }

  const transcriptTmpDir = `${TMP_FOLDER}/transcript_${jobId}`;
  await fs.promises.mkdir(transcriptTmpDir, { recursive: true });

  try {
    const transcript = await extractTranscript(
      normalizedUrl,
      transcriptTmpDir,
      jobId,
      runProxy,
      job.abortSignal,
    );

    if (transcript) {
      await storeTranscriptContent(
        bookmarkId,
        userId,
        transcript,
        jobId,
        normalizedUrl,
      );
    }
  } finally {
    await fs.promises
      .rm(transcriptTmpDir, { recursive: true, force: true })
      .catch(() => {
        // Ignore cleanup errors
      });
  }
}

/**
 * Deletes leftover assets in case the download fails
 *
 * @param jobId the id of the job
 * @param assetId the id of the asset to delete
 */
async function deleteLeftOverAssetFile(
  jobId: string,
  assetId: string,
): Promise<void> {
  let assetFile;
  try {
    assetFile = await findAssetFile(assetId);
  } catch {
    // ignore exception, no asset file was found
    return;
  }
  if (!assetFile) {
    return;
  }
  logger.info(
    `[VideoCrawler][${jobId}] Deleting leftover video asset "${assetFile}".`,
  );
  try {
    await fs.promises.rm(assetFile);
  } catch {
    logger.error(
      `[VideoCrawler][${jobId}] Failed deleting leftover video asset "${assetFile}".`,
    );
  }
}

/**
 * yt-dlp automatically adds a file ending to the passed in filename --> we have to search it again in the folder
 *
 * @param assetId the id of the asset to search
 * @returns the path to the downloaded asset
 */
async function findAssetFile(assetId: string): Promise<string | null> {
  const files = await fs.promises.readdir(TMP_FOLDER);
  for (const file of files) {
    if (file.startsWith(assetId)) {
      return path.join(TMP_FOLDER, file);
    }
  }
  return null;
}
