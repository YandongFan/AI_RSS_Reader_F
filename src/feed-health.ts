import type { FeedSource } from './types';
import { fetchFeed } from './rss';

export interface FeedHealthResult {
  feed: FeedSource;
  ok: boolean;
  hasEntries: boolean;
  error?: string;
}

type FeedProbe = (feed: FeedSource) => Promise<{ length: number }>;

export async function checkAllFeeds(
  feeds: FeedSource[],
  probe: FeedProbe = (feed) => fetchFeed(feed, 1),
): Promise<FeedHealthResult[]> {
  return Promise.all(feeds.map(async (feed) => {
    try {
      const articles = await probe(feed);
      return { feed, ok: true, hasEntries: articles.length > 0 };
    } catch (error) {
      return {
        feed,
        ok: false,
        hasEntries: false,
        error: errorMessage(error),
      };
    }
  }));
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return String(error);
}
