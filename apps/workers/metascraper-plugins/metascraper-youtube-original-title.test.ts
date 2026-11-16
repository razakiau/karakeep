import metascraper from "metascraper";
import metascraperTitle from "metascraper-title";
import metascraperYoutube from "metascraper-youtube";
import { describe, expect, test } from "vitest";

import metascraperYoutubeOriginalTitle from "./metascraper-youtube-original-title";

const parser = metascraper([
  metascraperYoutubeOriginalTitle(),
  metascraperYoutube(),
  metascraperTitle(),
]);

const page = (head: string) => `<html><head>${head}</head><body></body></html>`;

describe("metascraperYoutubeOriginalTitle", () => {
  test("keeps the original title when YouTube translated <title>", async () => {
    const meta = await parser({
      url: "https://www.youtube.com/watch?v=hWe-j78vNpc",
      html: page(`
        <title>Le dépôt racine : une configuration d'agent multi-dépôt sans effort - YouTube</title>
        <meta property="og:title" content="The Home Repo: The effortless multi-repo agent setup">
      `),
      validateUrl: false,
    });
    expect(meta.title).toBe(
      "The Home Repo: The effortless multi-repo agent setup",
    );
  });

  test("handles /live/ links", async () => {
    const meta = await parser({
      url: "https://www.youtube.com/live/4rI0zATFxYI",
      html: page(`
        <title>Questions aux experts : Évaluation des compétences des agents - YouTube</title>
        <meta property="og:title" content="Ask the Experts: Evaluating Agent Skills | Nemotron Labs">
      `),
      validateUrl: false,
    });
    expect(meta.title).toBe(
      "Ask the Experts: Evaluating Agent Skills | Nemotron Labs",
    );
  });

  test("falls back to <title> when og:title is missing", async () => {
    const meta = await parser({
      url: "https://www.youtube.com/watch?v=abc",
      html: page(`<title>Some video - YouTube</title>`),
      validateUrl: false,
    });
    expect(meta.title).toBe("Some video");
  });

  test("leaves other sites to the generic rules", async () => {
    const meta = await metascraper([metascraperYoutubeOriginalTitle()])({
      url: "https://example.com/post",
      html: page(`<meta property="og:title" content="Example">`),
      validateUrl: false,
    });
    expect(meta.title).toBeFalsy();
  });
});
