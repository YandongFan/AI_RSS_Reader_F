import { articleStatus, setArticleStatus } from './article-state';
import type { AiRssSettings, RssArticle } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneResult {
  articles: RssArticle[];
  removed: number;
  changed: boolean;
}

function retentionDays(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Retains expired entries for recovery; saved files are never touched. */
export function pruneExpiredArticles(
  articles: RssArticle[],
  settings: Pick<AiRssSettings, 'readRetentionDays' | 'unreadRetentionDays'>,
  now = Date.now(),
): PruneResult {
  const readDays = retentionDays(settings.readRetentionDays);
  const unreadDays = retentionDays(settings.unreadRetentionDays);
  const removed = 0;
  let changed = false;
  const kept: RssArticle[] = [];

  for (const article of articles) {
    let candidate = article;
    const status = articleStatus(article);
    if (article.status !== status || article.read !== (status !== 'unread')) {
      candidate = { ...article, status, read: status !== 'unread' };
      changed = true;
    }
    if (['interested', 'archived', 'expired'].includes(status)) { kept.push(candidate); continue; }
    if (article.read && !timestamp(article.readAt)) {
      candidate = { ...candidate, readAt: new Date(now).toISOString() };
      changed = true;
    }

    const days = status === 'hidden' ? readDays : unreadDays;
    const start = status === 'hidden' ? timestamp(candidate.statusChangedAt || candidate.readAt) : timestamp(candidate.statusChangedAt || candidate.fetchedAt);
    if (days > 0 && start !== undefined && now - start >= days * DAY_MS) {
      candidate = { ...candidate, status: 'expired' };
      setArticleStatus(candidate, 'expired', now);
      changed = true;
    }
    kept.push(candidate);
  }

  return { articles: kept, removed, changed };
}

export function setArticleRead(article: RssArticle, read: boolean, now = Date.now()): void {
  if (!read || articleStatus(article) === 'unread') setArticleStatus(article, read ? 'archived' : 'unread', now);
  article.read = read;
  article.readAt = read ? new Date(now).toISOString() : undefined;
}
