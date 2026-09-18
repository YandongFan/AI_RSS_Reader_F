import type { ResearchProfile, RssArticle } from './types';

/** Only enabled directions affect AI analysis; list order does not change its meaning. */
export function researchProfileFingerprint(profiles: ResearchProfile[]): string {
  return JSON.stringify(profiles
    .filter(profile => profile.enabled)
    .map(profile => ({ id: profile.id, name: profile.name.trim(), description: profile.description.trim() }))
    .sort((left, right) => left.id.localeCompare(right.id)));
}

/** Select articles received from RSS during the configured rolling window. */
export function recentRssArticles(articles: RssArticle[], days: number, now = Date.now()): RssArticle[] {
  if (days <= 0) return [];
  const cutoff = now - Math.max(0, days) * 86400000;
  return articles.filter(article => {
    if (article.source === '手动导入') return false;
    const fetched = Date.parse(article.fetchedAt);
    return Number.isFinite(fetched) && fetched >= cutoff;
  });
}

export function mergeAnalysisCandidates(...groups: RssArticle[][]): RssArticle[] {
  const seen = new Set<string>();
  return groups.flat().filter(article => {
    const key = article.link || article.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
