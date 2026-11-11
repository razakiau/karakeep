/**
 * Choosing which subtitle track becomes a video's transcript.
 *
 * YouTube names many tracks with a region (`en-US`, `de-DE`) and the
 * automatic captions in the spoken language `<lang>-orig`. A bare `en` is
 * often a machine translation, which YouTube rate-limits with HTTP 429. Asking
 * yt-dlp for the exact codes `en,fr,...` therefore got nothing at all on
 * those videos, and the bookmark silently kept its description.
 */

const LANG_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*$/;

function configuredLangs(transcriptLangs: string): string[] {
  return transcriptLangs
    .split(",")
    .map((l) => l.trim())
    .filter((l) => LANG_CODE.test(l));
}

function baseOf(lang: string): string {
  return lang.split("-")[0].toLowerCase();
}

/**
 * The `--sub-lang` value: each configured language plus its regional and
 * `-orig` variants. yt-dlp matches it as a case-insensitive full match.
 */
export function buildSubLangPattern(transcriptLangs: string): string {
  const bases = [...new Set(configuredLangs(transcriptLangs).map(baseOf))];
  if (bases.length === 0) return transcriptLangs;
  return `(${bases.join("|")})(-[A-Za-z]+)?(-orig)?`;
}

/** `<id>.<lang>.vtt` -> `<lang>` (YouTube ids contain no dots). */
export function subtitleLang(file: string): string | null {
  if (!file.endsWith(".vtt")) return null;
  const stem = file.slice(0, -".vtt".length);
  const dot = stem.lastIndexOf(".");
  return dot === -1 ? null : stem.slice(dot + 1);
}

/** `<base>`, or `<base>-XX` where XX is an upper-case region (not `de-en`, a translation). */
function isNativeTrack(lang: string, base: string): boolean {
  return lang === base || new RegExp(`^${base}-[A-Z]{2}$`).test(lang);
}

/**
 * Picks the transcript file, or null when none is acceptable.
 *
 * When the video's language is known and configured, only a track in that
 * language is accepted, in this order: the exact track (`en-US`), the
 * automatic captions in the spoken language (`en-orig`), then `en` or another
 * regional variant. A translation into another language is never chosen.
 *
 * Otherwise (language unknown, or not one of the configured ones) the
 * configured order decides, preferring native tracks over `-orig` ones.
 */
export function pickSubtitleFile(
  files: string[],
  originalLanguage: string | null,
  transcriptLangs: string,
): string | null {
  const byLang = new Map<string, string>();
  for (const f of files) {
    const lang = subtitleLang(f);
    if (lang) byLang.set(lang, f);
  }
  if (byLang.size === 0) return null;

  const langs = configuredLangs(transcriptLangs);
  const bases = langs.map(baseOf);
  // yt-dlp prints `NA` when the site doesn't say.
  const trimmed = originalLanguage?.trim() ?? "";
  const original = trimmed !== "NA" && LANG_CODE.test(trimmed) ? trimmed : null;

  if (original && bases.includes(baseOf(original))) {
    const base = baseOf(original);
    const exact = byLang.get(original);
    if (exact) return exact;
    const orig = byLang.get(`${base}-orig`);
    if (orig) return orig;
    for (const [lang, file] of byLang) {
      if (isNativeTrack(lang, base)) return file;
    }
    return null;
  }

  for (const base of bases) {
    for (const [lang, file] of byLang) {
      if (isNativeTrack(lang, base)) return file;
    }
    const orig = byLang.get(`${base}-orig`);
    if (orig) return orig;
  }
  return null;
}
