import "server-only";
import { sql } from "../db";
import { logError } from "../errors";
import type { CountryCode } from "../../invest/catalog";
import { parseFeed, stripHtml, tagNews } from "../../invest/news-parse";
import { cacheGet, cacheSet } from "./cache";
import { fetchText, keys, nytTopStories } from "./providers";

// Headlines from established publishers' official RSS feeds (and the NYT API when a key is set).
// HARU stores the headline, a short summary and the link; reading happens on the publisher's site.

export interface FeedDef {
  id: string;
  source: string;
  url: string;
  countries: CountryCode[];
  lang: "en" | "hi";
}

export const FEEDS: FeedDef[] = [
  // India
  { id: "et-markets", source: "The Economic Times", url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", countries: ["IN"], lang: "en" },
  { id: "et-top", source: "The Economic Times", url: "https://economictimes.indiatimes.com/rssfeedstopstories.cms", countries: ["IN"], lang: "en" },
  { id: "mint-markets", source: "Mint", url: "https://www.livemint.com/rss/markets", countries: ["IN"], lang: "en" },
  { id: "bl-markets", source: "BusinessLine", url: "https://www.thehindubusinessline.com/markets/feeder/default.rss", countries: ["IN"], lang: "en" },
  { id: "aajtak", source: "Aaj Tak", url: "https://www.aajtak.in/rssfeeds/?id=home", countries: ["IN"], lang: "hi" },
  // Canada
  { id: "cbc-business", source: "CBC News", url: "https://www.cbc.ca/webfeed/rss/rss-business", countries: ["CA"], lang: "en" },
  { id: "fp", source: "Financial Post", url: "https://financialpost.com/feed/", countries: ["CA"], lang: "en" },
  { id: "globe-business", source: "The Globe and Mail", url: "https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/", countries: ["CA"], lang: "en" },
  // World
  { id: "nyt-business", source: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", countries: ["WORLD"], lang: "en" },
  { id: "nyt-world", source: "The New York Times", url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", countries: ["WORLD"], lang: "en" },
  { id: "wapo-business", source: "The Washington Post", url: "https://feeds.washingtonpost.com/rss/business", countries: ["WORLD"], lang: "en" },
  { id: "bbc-business", source: "BBC News", url: "https://feeds.bbci.co.uk/news/business/rss.xml", countries: ["WORLD"], lang: "en" },
  { id: "cbc-world", source: "CBC News", url: "https://www.cbc.ca/webfeed/rss/rss-world", countries: ["WORLD"], lang: "en" },
];

export interface FeedHealth {
  id: string;
  source: string;
  ok: boolean;
  items: number;
  error?: string;
  at: string;
}

const REFRESH_MS = 15 * 60e3;
const KEEP_DAYS = 10;

interface Row {
  url: string;
  source: string;
  feed: string;
  title: string;
  summary: string | null;
  image: string | null;
  lang: string;
  published_at: Date;
  countries: string[];
  interests: string[];
  tags: string[];
}

async function upsert(rows: Row[]) {
  for (const r of rows) {
    await sql`
      insert into news_items (url, source, feed, title, summary, image, lang, published_at, countries, interests, tags)
      values (${r.url}, ${r.source}, ${r.feed}, ${r.title}, ${r.summary}, ${r.image}, ${r.lang}, ${r.published_at},
              ${sql.array(r.countries)}::text[], ${sql.array(r.interests)}::text[], ${sql.array(r.tags)}::text[])
      on conflict (url) do update set title = excluded.title, summary = excluded.summary, image = coalesce(excluded.image, news_items.image),
        countries = excluded.countries, interests = excluded.interests, tags = excluded.tags`;
  }
}

/** Pull every feed (in parallel, each with a timeout), tag, store, prune. One failing feed never blocks the rest. */
export async function refreshNews(): Promise<FeedHealth[]> {
  const now = new Date();
  const health: FeedHealth[] = await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const items = parseFeed(await fetchText(f.url), now).slice(0, 40);
        await upsert(
          items.map((it) => {
            const t = tagNews(it.title, it.summary, f.countries);
            return { url: it.url, source: f.source, feed: f.id, title: it.title, summary: it.summary, image: it.image, lang: f.lang, published_at: it.publishedAt, ...t };
          }),
        );
        return { id: f.id, source: f.source, ok: true, items: items.length, at: now.toISOString() };
      } catch (e) {
        return { id: f.id, source: f.source, ok: false, items: 0, error: (e as Error).message.slice(0, 120), at: now.toISOString() };
      }
    }),
  );
  if (keys.nyt()) {
    for (const section of ["business", "world"] as const) {
      try {
        const res = await nytTopStories(section);
        await upsert(
          res
            .filter((r) => /^https?:\/\//.test(r.url) && r.title)
            .slice(0, 30)
            .map((r) => {
              const summary = stripHtml(r.abstract ?? "").slice(0, 280) || null;
              const t = tagNews(r.title, summary, ["WORLD"]);
              return { url: r.url, source: "The New York Times", feed: `nyt-api-${section}`, title: r.title, summary, image: r.multimedia?.find((m) => /^https:/.test(m.url))?.url ?? null, lang: "en", published_at: new Date(r.published_date || now), ...t };
            }),
        );
        health.push({ id: `nyt-api-${section}`, source: "The New York Times (API)", ok: true, items: res.length, at: now.toISOString() });
      } catch (e) {
        health.push({ id: `nyt-api-${section}`, source: "The New York Times (API)", ok: false, items: 0, error: (e as Error).message.slice(0, 120), at: now.toISOString() });
      }
    }
  }
  await sql`delete from news_items where published_at < now() - make_interval(days => ${KEEP_DAYS})`;
  await cacheSet("news:health", health, 7 * 86400e3);
  await cacheSet("news:refreshed", { at: now.toISOString() }, REFRESH_MS);
  return health;
}

let inFlight: Promise<unknown> | null = null;
/** Refresh if the last pull is older than 15 minutes. Waits at most `waitMs`; the pull keeps going in the background. */
export async function refreshNewsIfStale(waitMs = 4000): Promise<void> {
  const last = await cacheGet<{ at: string }>("news:refreshed");
  if (last && last.expiresAt > Date.now()) return;
  if (!inFlight) inFlight = refreshNews().catch((e) => logError("news.refresh", e)).finally(() => (inFlight = null));
  await Promise.race([inFlight, new Promise((r) => setTimeout(r, waitMs))]);
}

export interface NewsItem {
  id: number;
  url: string;
  source: string;
  title: string;
  summary: string | null;
  image: string | null;
  lang: string;
  publishedAt: string;
  countries: string[];
  interests: string[];
  tags: string[];
}

export async function listNews(opts: { country: CountryCode; interests?: string[]; tags?: string[]; limit?: number }): Promise<NewsItem[]> {
  const limit = opts.limit ?? 120;
  const narrow = !!(opts.tags?.length || opts.interests?.length);
  const rows = narrow
    ? await sql<(Row & { id: number })[]>`
        select id, url, source, feed, title, summary, image, lang, published_at, countries, interests, tags from news_items
        where ${opts.country} = any(countries) and (tags && ${sql.array(opts.tags?.length ? opts.tags : ["-"])}::text[] or interests && ${sql.array(opts.interests?.length ? opts.interests : ["-"])}::text[])
        order by published_at desc limit ${limit}`
    : await sql<(Row & { id: number })[]>`
        select id, url, source, feed, title, summary, image, lang, published_at, countries, interests, tags from news_items
        where ${opts.country} = any(countries) order by published_at desc limit ${limit}`;
  return rows.map((r) => ({ id: Number(r.id), url: r.url, source: r.source, title: r.title, summary: r.summary, image: r.image, lang: r.lang, publishedAt: r.published_at.toISOString(), countries: r.countries, interests: r.interests, tags: r.tags }));
}

export async function feedHealth(): Promise<FeedHealth[]> {
  return (await cacheGet<FeedHealth[]>("news:health"))?.data ?? [];
}
