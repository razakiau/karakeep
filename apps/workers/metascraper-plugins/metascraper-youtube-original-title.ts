import type { CheerioAPI } from "cheerio";
import type { Rules, RulesOptions } from "metascraper";

/**
 * metascraper-youtube reads the title from <title>, which YouTube
 * auto-translates into the viewer's language (a French exit IP turns
 * "The Home Repo: ..." into "Le dépôt racine : ..."). og:title keeps the
 * title the channel wrote, so prefer it. Returns undefined when og:title is
 * missing (e.g. a consent page), letting the next plugin handle the title.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

const test = ({ url }: { url: string }): boolean => {
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

const metascraperYoutubeOriginalTitle = () => {
  const rules: Rules = {
    pkgName: "metascraper-youtube-original-title",
    test,
    title: (({ htmlDom }: { htmlDom: CheerioAPI }) => {
      const title = htmlDom('meta[property="og:title"]').attr("content");
      return title?.trim() || undefined;
    }) as unknown as RulesOptions,
  };
  return rules;
};

export default metascraperYoutubeOriginalTitle;
