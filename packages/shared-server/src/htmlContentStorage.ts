import { db } from "@karakeep/db";
import { ASSET_TYPES, newAssetId, saveAsset } from "@karakeep/shared/assetdb";
import serverConfig from "@karakeep/shared/config";
import logger from "@karakeep/shared/logger";
import { tryCatch } from "@karakeep/shared/tryCatch";

import { QuotaService } from "./services/quotaService";
import { getTracer, withSpan } from "./tracing";

const tracer = getTracer("@karakeep/shared-server");

export type StoreHtmlResult =
  | { result: "stored"; assetId: string; size: number }
  | { result: "store_inline" }
  | { result: "not_stored" };

/**
 * Determines how to store HTML content based on size threshold and quota.
 * - Content below threshold: returns "store_inline" (caller stores in DB column)
 * - Content at/above threshold: saves to the asset store and returns the assetId
 * - Quota exceeded or no content: returns "not_stored"
 *
 * Lives here rather than in the crawler so that both the workers and the tRPC
 * layer (manual content edits) can share a single implementation.
 */
export async function storeHtmlContent(
  htmlContent: string | undefined,
  userId: string,
  jobId: string,
  /**
   * Log prefix. Defaults to "Crawler" so existing crawler log lines are
   * unchanged; other callers pass their own.
   */
  logContext = "Crawler",
): Promise<StoreHtmlResult> {
  return await withSpan(
    tracer,
    "crawlerWorker.storeHtmlContent",
    {
      attributes: {
        "job.id": jobId,
        "user.id": userId,
        "bookmark.content.size": htmlContent
          ? Buffer.byteLength(htmlContent, "utf8")
          : 0,
      },
    },
    async () => {
      if (!htmlContent) {
        return { result: "not_stored" };
      }

      const contentSize = Buffer.byteLength(htmlContent, "utf8");

      // Only store in assets if content is >= 50KB
      if (contentSize < serverConfig.crawler.htmlContentSizeThreshold) {
        logger.info(
          `[${logContext}][${jobId}] HTML content size (${contentSize} bytes) is below threshold, storing inline`,
        );
        return { result: "store_inline" };
      }

      const { data: quotaApproved, error: quotaError } = await tryCatch(
        QuotaService.checkStorageQuota(db, userId, contentSize),
      );
      if (quotaError) {
        logger.warn(
          `[${logContext}][${jobId}] Skipping HTML content storage due to quota exceeded: ${quotaError.message}`,
        );
        return { result: "not_stored" };
      }

      const assetId = newAssetId();

      const { error: saveError } = await tryCatch(
        saveAsset({
          userId,
          assetId,
          asset: Buffer.from(htmlContent, "utf8"),
          metadata: {
            contentType: ASSET_TYPES.TEXT_HTML,
            fileName: null,
          },
          quotaApproved,
        }),
      );
      if (saveError) {
        logger.error(
          `[${logContext}][${jobId}] Failed to store HTML content as asset: ${saveError}`,
        );
        throw saveError;
      }

      logger.info(
        `[${logContext}][${jobId}] Stored large HTML content (${contentSize} bytes) as asset: ${assetId}`,
      );

      return {
        result: "stored",
        assetId,
        size: contentSize,
      };
    },
  );
}
