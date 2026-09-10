import type { FeedSource } from './types';
import type { FeedHealthResult } from './feed-health';

export const RSS_SOURCE_FILE = 'rss-sources.json';

export function serializeFeedSources(feeds: FeedSource[], results: FeedHealthResult[]): string {
  const health = new Map(results.map(result => [result.feed.id, result]));
  return JSON.stringify({ version: 1, checkedAt: new Date().toISOString(), feeds: feeds.map(feed => ({
    name: feed.name, url: feed.url, enabled: feed.enabled,
    health: health.get(feed.id)?.ok ? 'ok' : 'failed',
  })) }, null, 2) + '\n';
}

export function importFeedSources(contents: string, existing: FeedSource[], makeId: () => string): FeedSource[] {
  const value: unknown = JSON.parse(contents);
  const rows = Array.isArray(value) ? value : value && typeof value === 'object' && 'feeds' in value ? value.feeds : undefined;
  if (!Array.isArray(rows)) throw new Error('RSS 文件需要包含 feeds 数组');
  const normalized = rows.map((row, index) => {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string') throw new Error(`第 ${index + 1} 项缺少 RSS 链接`);
    let url: URL;
    try { url = new URL(row.url.trim()); } catch { throw new Error(`第 ${index + 1} 项 RSS 链接无效`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`第 ${index + 1} 项需要不含用户名密码的 HTTP(S) 链接`);
    url.hash = '';
    return { url: url.href, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : url.hostname, enabled: row.enabled !== false };
  });
  const result = existing.map(feed => ({ ...feed }));
  const byUrl = new Map(result.map(feed => { try { const url = new URL(feed.url); url.hash = ''; return [url.href, feed] as const; } catch { return [feed.url, feed] as const; } }));
  for (const row of normalized) {
    const previous = byUrl.get(row.url);
    if (previous) Object.assign(previous, row);
    else { const feed = { ...row, id: makeId() }; result.push(feed); byUrl.set(row.url, feed); }
  }
  return result;
}
