import { extractArticleImage } from './article-image';
import { requestUrl } from 'obsidian';
import type { FeedSource, RssArticle } from './types';

const text = (node: Element | null, selectors: string[]): string => {
  for (const selector of selectors) {
    const value = node?.querySelector(selector)?.textContent?.trim();
    if (value) return value;
  }
  return '';
};

const stripHtml = (value: string): string => {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
};

const stableId = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rss-${(hash >>> 0).toString(36)}`;
};

const entryLink = (entry: Element): string => {
  const links = Array.from(entry.querySelectorAll('link'));
  const alternate = links.find((link) => !link.getAttribute('rel') || link.getAttribute('rel') === 'alternate');
  return alternate?.getAttribute('href')?.trim() || alternate?.textContent?.trim() || text(entry, ['guid', 'id']);
};

export async function fetchFeed(feed: FeedSource, limit: number): Promise<RssArticle[]> {
  const response = await requestUrl({
    url: feed.url,
    method: 'GET',
    headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
    throw: false,
  });
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);

  const xml = new DOMParser().parseFromString(response.text, 'application/xml');
  const parserError = xml.querySelector('parsererror');
  if (parserError) throw new Error('订阅内容不是有效的 XML');

  const rootName = xml.documentElement?.localName.toLowerCase();
  if (!rootName || !['rss', 'feed', 'rdf'].includes(rootName)) throw new Error('内容不是 RSS 或 Atom 订阅');

  const nodes = Array.from(xml.querySelectorAll('item, entry')).slice(0, limit);
  return nodes.map((entry) => {
    const link = entryLink(entry);
    const title = stripHtml(text(entry, ['title'])) || '无标题';
    const summary = stripHtml(text(entry, ['content', 'content\\:encoded', 'summary', 'description']));
    const published = text(entry, ['published', 'pubDate', 'updated', 'dc\\:date']);
    return {
      id: stableId(link || `${feed.url}|${title}|${published}`),
      title,
      link,
      summary,
      authors: text(entry, ['author', 'dc\\:creator', 'creator']),
      imageUrl: extractArticleImage(entry, link || feed.url),
      updatedAt: new Date().toISOString(),
      status: 'unread',
      published,
      source: feed.name,
      fetchedAt: new Date().toISOString(),
      read: false,
      matchedProfiles: [],
      analysis: {},
    };
  });
}

export async function fetchAllFeeds(
  feeds: FeedSource[],
  limit: number,
  onFeedDone?: (feed: FeedSource, error?: string) => void,
): Promise<RssArticle[]> {
  const results = await Promise.all(
    feeds.filter((feed) => feed.enabled).map(async (feed) => {
      try {
        const articles = await fetchFeed(feed, limit);
        onFeedDone?.(feed);
        return articles;
      } catch (error) {
        onFeedDone?.(feed, error instanceof Error ? error.message : String(error));
        return [];
      }
    }),
  );

  const unique = new Map<string, RssArticle>();
  for (const article of results.flat()) {
    const key = article.link || article.id;
    const existing = unique.get(key);
    if (!existing || existing.summary.length < article.summary.length) unique.set(key, article);
  }
  return [...unique.values()];
}

export function keywordPrefilter(articles: RssArticle[], descriptions: string[]): RssArticle[] {
  const stopwords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'into', 'over', 'about']);
  const keywords = descriptions
    .flatMap((description) => description.toLowerCase().split(/[\s,;，；。.、()[\]{}]+/))
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !stopwords.has(word));
  if (keywords.length === 0) return articles;
  return articles.filter((article) => {
    const haystack = `${article.title} ${article.summary}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}
