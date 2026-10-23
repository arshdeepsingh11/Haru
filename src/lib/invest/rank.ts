// "For you": rank headlines by what this person follows and what they actually open.

export interface RankableNews {
  id: number;
  source: string;
  publishedAt: string;
  countries: string[];
  interests: string[];
  tags: string[];
}

export interface Signal {
  kind: string;
  ref: string | null;
  tags: string[];
  at: string;
}

/** Affinity per tag/interest from behaviour: recent and repeated actions count more. */
export function affinity(signals: Signal[], now = Date.now()): Map<string, number> {
  const w: Record<string, number> = { view_asset: 1.5, open_news: 1, save: 3, unsave: -2, search: 1, select_interest: 2, ask: 1.5 };
  const out = new Map<string, number>();
  for (const s of signals) {
    const ageDays = Math.max(0, (now - Date.parse(s.at)) / 86400e3);
    const decay = Math.exp(-ageDays / 21); // ~3-week memory
    const add = (k: string) => out.set(k, (out.get(k) ?? 0) + (w[s.kind] ?? 0.5) * decay);
    for (const t of s.tags) add(t);
    if (s.ref) add(s.ref);
  }
  return out;
}

export function rankNews<T extends RankableNews>(items: T[], opts: { country: string; interests: string[]; affinity: Map<string, number>; now?: number; limit?: number }): T[] {
  const now = opts.now ?? Date.now();
  const scored = items.map((n) => {
    const hours = Math.max(0, (now - Date.parse(n.publishedAt)) / 3600e3);
    let score = 4 * Math.exp(-hours / 18); // fresh news first
    if (n.countries.includes(opts.country)) score += opts.country === "WORLD" ? 0.5 : 2;
    const matched = n.interests.filter((i) => opts.interests.includes(i)).length;
    score += Math.min(matched, 2) * 2.5;
    for (const t of [...n.tags, ...n.interests]) score += Math.min(2, Math.log1p(Math.max(0, opts.affinity.get(t) ?? 0)));
    return { n, score };
  });
  scored.sort((a, b) => b.score - a.score);
  // Keep the feed varied: at most 3 stories per source in the top results.
  const perSource = new Map<string, number>();
  const out: T[] = [];
  const rest: T[] = [];
  for (const { n } of scored) {
    const c = perSource.get(n.source) ?? 0;
    if (c < 3) {
      out.push(n);
      perSource.set(n.source, c + 1);
    } else rest.push(n);
  }
  return [...out, ...rest].slice(0, opts.limit ?? 30);
}
