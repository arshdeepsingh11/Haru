// Read publishers' RSS/Atom feeds and tag each headline with countries, interests and assets.
// Only the title, a short summary, the link and the image are kept; the article stays on the publisher's site.

import { ASSETS, COUNTRIES, type CountryCode } from "./catalog";

export interface FeedItem {
  url: string;
  title: string;
  summary: string | null;
  image: string | null;
  publishedAt: Date;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…" };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripHtml(s: string): string {
  return decodeEntities(s)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi, (m) => decodeEntities(m)) // double-escaped feeds
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return m ? m[1].trim() : null;
}
function attr(block: string, name: string, a: string): string | null {
  const m = new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["'][^>]*>`, "i").exec(block);
  return m ? decodeEntities(m[1]) : null;
}

/** Parse RSS 2.0 <item> or Atom <entry> blocks. Bad items are skipped, never thrown. */
export function parseFeed(xml: string, now = new Date()): FeedItem[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const out: FeedItem[] = [];
  for (const b of blocks) {
    const title = stripHtml(tag(b, "title") ?? "");
    let url = stripHtml(tag(b, "link") ?? "") || attr(b, "link", "href") || "";
    if (!/^https?:\/\//.test(url)) url = stripHtml(tag(b, "guid") ?? "");
    if (!title || !/^https?:\/\//.test(url)) continue;
    const rawDate = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const d = rawDate ? new Date(stripHtml(rawDate)) : now;
    const desc = tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content:encoded") ?? tag(b, "content");
    const summary = desc ? stripHtml(desc).slice(0, 280) || null : null;
    const image = attr(b, "media:content", "url") ?? attr(b, "media:thumbnail", "url") ?? attr(b, "enclosure", "url") ?? (desc ? /<img[^>]+src=["']([^"']+)["']/i.exec(decodeEntities(desc))?.[1] ?? null : null);
    out.push({ url: url.slice(0, 1000), title: title.slice(0, 300), summary, image: image && /^https:\/\//.test(image) ? image : null, publishedAt: isNaN(d.getTime()) || d > new Date(now.getTime() + 3600e3) ? now : d });
  }
  return out;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/[“”"'’‘(),.:;!?|\-–—]/g, " ").replace(/\s+/g, " ")} `;
const has = (hay: string, word: string) => (/[^\x00-\x7f]/.test(word) ? hay.includes(word.toLowerCase()) : hay.includes(` ${word.toLowerCase()} `) || (word.length > 6 && hay.includes(word.toLowerCase())));

export interface NewsTags {
  countries: CountryCode[];
  interests: string[];
  tags: string[]; // asset keys
}

/** Tag a headline. `feedCountries` are the feed's home countries (an Indian paper's story is about India unless it says otherwise). */
export function tagNews(title: string, summary: string | null, feedCountries: CountryCode[]): NewsTags {
  const hay = norm(`${title} ${summary ?? ""}`);
  const countries = new Set<CountryCode>();
  for (const c of COUNTRIES) if (c.code !== "WORLD" && c.words.some((w) => has(hay, w))) countries.add(c.code);
  if (!countries.size) for (const c of feedCountries) countries.add(c);
  countries.add("WORLD");
  const interests = new Set<string>();
  for (const c of COUNTRIES) for (const i of c.interests) if (i.words.some((w) => has(hay, w))) interests.add(i.key);
  const tags = new Set<string>();
  for (const a of ASSETS) if (a.kind !== "fx" && a.words?.some((w) => w.length >= 3 && has(hay, w))) tags.add(a.key);
  return { countries: [...countries], interests: [...interests], tags: [...tags] };
}
