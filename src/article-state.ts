import type { ArticleSort, ArticleStatus, RecommendationScore, RssArticle } from './types';

export function isCurated(article: RssArticle): boolean {
  return article.curated ?? article.matchedProfiles?.length > 0;
}

/** Curated papers are virtual positives; their reader status is not changed. */
export function recommendationArticles(articles: RssArticle[]): RssArticle[] {
  return articles.map(article => isCurated(article) ? { ...article, status: 'interested', read: true } : article);
}

export const ARTICLE_STATUSES: Record<ArticleStatus, string> = {
  unread: '未读', interested: '感兴趣', archived: '归档', hidden: '已隐藏', expired: '已过期',
};

export function articleStatus(article: RssArticle): ArticleStatus {
  if (article.status && Object.hasOwnProperty.call(ARTICLE_STATUSES, article.status)) return article.status;
  return article.read || article.savedPath ? 'archived' : 'unread';
}

export function setArticleStatus(article: RssArticle, status: ArticleStatus, now = Date.now()): void {
  article.status = status;
  article.statusChangedAt = new Date(now).toISOString();
  article.read = status !== 'unread';
  article.readAt = article.read ? article.statusChangedAt : undefined;
}

const time = (value?: string): number => Date.parse(value ?? '') || 0;

export function sortArticles(articles: RssArticle[], sort: ArticleSort, scores: Record<string, RecommendationScore> = {}, reversed = false): RssArticle[] {
  const tiers = { high: 0, pending: 1, low: 3 };
  return [...articles].sort((a, b) => {
    let order = 0;
    if (sort === 'title') order = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    if (sort === 'journal') order = a.source.localeCompare(b.source, undefined, { sensitivity: 'base' }) || a.title.localeCompare(b.title);
    if (sort === 'updated') order = time(b.updatedAt || b.fetchedAt) - time(a.updatedAt || a.fetchedAt);
    if (sort === 'relevance') {
      const left = scores[a.id]; const right = scores[b.id];
      order = (left ? tiers[left.tier] : 2) - (right ? tiers[right.tier] : 2) || (right?.score ?? -1) - (left?.score ?? -1);
    }
    const result = order || time(b.published || b.fetchedAt) - time(a.published || a.fetchedAt) || b.id.localeCompare(a.id);
    return reversed ? -result : result;
  });
}
