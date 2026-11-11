import { describe, expect, test } from "vitest";

import {
  buildSubLangPattern,
  pickSubtitleFile,
  subtitleLang,
} from "./subtitlePicker";

const LANGS = "en,fr,ar,de";

// The tracks yt-dlp wrote for real videos (ZAC-317), with the pattern below.
const KENT_BECK = [
  "F8fBgDCf2Y4.ar-orig.vtt",
  "F8fBgDCf2Y4.de-DE-orig.vtt",
  "F8fBgDCf2Y4.de-DE.vtt",
  "F8fBgDCf2Y4.en-US.vtt",
  "F8fBgDCf2Y4.en-orig.vtt",
  "F8fBgDCf2Y4.fr-FR-orig.vtt",
  "F8fBgDCf2Y4.fr-FR.vtt",
];
const MANY_TRANSLATIONS = [
  "wjZofJX0v4M.ar-ar.vtt",
  "wjZofJX0v4M.ar.vtt",
  "wjZofJX0v4M.de-de.vtt",
  "wjZofJX0v4M.de-en.vtt",
  "wjZofJX0v4M.de.vtt",
  "wjZofJX0v4M.en-en.vtt",
  "wjZofJX0v4M.en-orig.vtt",
  "wjZofJX0v4M.en.vtt",
  "wjZofJX0v4M.fr-fr.vtt",
  "wjZofJX0v4M.fr.vtt",
];

describe("buildSubLangPattern", () => {
  test("matches regional and -orig tracks, not only exact codes", () => {
    const re = new RegExp(`^${buildSubLangPattern(LANGS)}$`, "i");
    for (const l of ["en", "en-US", "en-orig", "de-DE-orig", "fr-FR", "ar"]) {
      expect(re.test(l), l).toBe(true);
    }
    for (const l of ["es", "zh-Hans", "pt-BR"]) {
      expect(re.test(l), l).toBe(false);
    }
  });

  test("reduces regional configuration to the base language", () => {
    expect(buildSubLangPattern("en-US, fr")).toBe(
      "(en|fr)(-[A-Za-z]+)?(-orig)?",
    );
  });

  test("drops values that are not language codes", () => {
    expect(buildSubLangPattern("en,.*,fr")).toBe(
      "(en|fr)(-[A-Za-z]+)?(-orig)?",
    );
  });
});

describe("subtitleLang", () => {
  test("reads the language from yt-dlp's file name", () => {
    expect(subtitleLang("F8fBgDCf2Y4.en-US.vtt")).toBe("en-US");
    expect(subtitleLang("uk372l-j3UI.en.vtt")).toBe("en");
    expect(subtitleLang("language.txt")).toBeNull();
  });
});

describe("pickSubtitleFile", () => {
  test("takes the manual regional track in the spoken language", () => {
    expect(pickSubtitleFile(KENT_BECK, "en-US\n", LANGS)).toBe(
      "F8fBgDCf2Y4.en-US.vtt",
    );
  });

  test("never takes a translation when the spoken language is known", () => {
    expect(
      pickSubtitleFile(["x.ar-orig.vtt", "x.fr-FR.vtt"], "en-US", LANGS),
    ).toBeNull();
  });

  test("falls back to the -orig captions when there is no manual track", () => {
    expect(
      pickSubtitleFile(
        ["x.de-orig.vtt", "x.en-orig.vtt", "x.fr-orig.vtt"],
        "en-US",
        LANGS,
      ),
    ).toBe("x.en-orig.vtt");
  });

  test("takes the exact track when the language has no region", () => {
    expect(pickSubtitleFile(MANY_TRANSLATIONS, "en", LANGS)).toBe(
      "wjZofJX0v4M.en.vtt",
    );
  });

  test("follows the spoken language, not the configured order", () => {
    expect(
      pickSubtitleFile(["x.fr-orig.vtt", "x.fr.vtt", "x.en.vtt"], "fr", LANGS),
    ).toBe("x.fr.vtt");
  });

  test("without a known language, uses the configured order, native first", () => {
    expect(pickSubtitleFile(KENT_BECK, "NA", LANGS)).toBe(
      "F8fBgDCf2Y4.en-US.vtt",
    );
    expect(
      pickSubtitleFile(["x.en-orig.vtt", "x.de-DE.vtt"], null, LANGS),
    ).toBe("x.en-orig.vtt");
    expect(pickSubtitleFile(["x.de-en.vtt", "x.de.vtt"], null, LANGS)).toBe(
      "x.de.vtt",
    );
  });

  test("spoken language outside the configured ones uses the configured order", () => {
    expect(pickSubtitleFile(["x.en-orig.vtt"], "es", LANGS)).toBe(
      "x.en-orig.vtt",
    );
  });

  test("no tracks -> null", () => {
    expect(pickSubtitleFile([], "en", LANGS)).toBeNull();
  });
});
