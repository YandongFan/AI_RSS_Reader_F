import { articleStatus } from './article-state';
import { extractDocumentTerms, trainLogisticCore, vectorizeDocument, stratifiedSplit, calibrateThresholds } from './recommendation-core';
import type { RecommendationState, RssArticle, PluginState } from './types';

const documentFor = (article: RssArticle): string => `${article.title} ${article.title} ${article.summary} journal:${article.source} ${article.authors ? `author:${article.authors}` : ''}`;
type Options = NonNullable<PluginState['recommendationOptions']>;
const defaults: Options = { disabledKeywords: [], lowThreshold: null, highThreshold: null, userInterest: '' };

export function recommendationFingerprint(articles: RssArticle[], options: Options = defaults): string {
  let hash = 2166136261;
  for (const article of [...articles].sort((a, b) => a.id.localeCompare(b.id))) {
    const text = JSON.stringify([article.id, articleStatus(article), documentFor(article)]);
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  for (const character of JSON.stringify(options)) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `v2-${hash >>> 0}`;
}

export async function buildRecommendations(articles: RssArticle[], yieldToUi = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 0)); }, options: Options = defaults, previous?: RecommendationState): Promise<RecommendationState> {
  const training = articles.filter(article => articleStatus(article) !== 'unread');
  const labels = training.map(article => ['interested', 'archived'].includes(articleStatus(article)) ? 1 : 0);
  const positive = labels.filter(Boolean).length;
  const negative = labels.length - positive;
  if (positive < 2 || negative < 2) throw new Error('至少需要 2 篇感兴趣/归档文章和 2 篇隐藏/过期文章，再更新关键词推荐。');
  const trainingFingerprint = recommendationFingerprint(training, options);
  const cached = previous?.trainingFingerprint === trainingFingerprint && previous.keywords?.length ? previous : undefined;
  const documents = training.map(documentFor);
  const frequencies = new Map<string, number>();
  for (let i = 0; i < documents.length; i++) {
    for (const term of new Set(extractDocumentTerms(documents[i]))) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    if (i % 25 === 0) await yieldToUi();
  }
  const vocabulary = [...frequencies].filter(([term, count]) => !options.disabledKeywords.includes(term) && count >= 2 && count / documents.length <= 0.9)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5000).map(([term]) => term);
  if (!vocabulary.length) throw new Error('样本没有足够的共同关键词，请增加分类样本后重试。');
  const idf = vocabulary.map(term => Math.log((documents.length + 1) / (frequencies.get(term)! + 1)) + 1);
  const vectors: import('./recommendation-core').SparseVector[] = [];
  for (let i = 0; i < documents.length; i++) {
    vectors.push(vectorizeDocument(documents[i], vocabulary, idf));
    if (i % 25 === 0) await yieldToUi();
  }
  const split = stratifiedSplit(labels);
  const model = cached ? { weights: vocabulary.map(term => cached.keywords!.find(keyword => keyword.term === term)?.weight ?? 0), intercept: cached.intercept ?? 0 }
    : await trainLogisticCore(vectors, labels, split.training, yieldToUi);
  const calibration = cached ? { accuracy: cached.accuracy ?? null, lowThreshold: cached.lowThreshold ?? 30, highThreshold: cached.highThreshold ?? 70 }
    : calibrateThresholds(vectors, labels, model, split.validation);
  const lowThreshold = options.lowThreshold ?? calibration.lowThreshold;
  const highThreshold = options.highThreshold ?? calibration.highThreshold;
  if (!(Number.isFinite(lowThreshold) && Number.isFinite(highThreshold) && lowThreshold >= 0 && highThreshold <= 100 && lowThreshold < highThreshold)) throw new Error('阈值须满足 0 ≤ 低阈值 < 高阈值 ≤ 100');
  const effectiveWeights = model.weights.map((weight, i) => options.disabledKeywords.includes(vocabulary[i]) ? 0 : weight);
  const positivePresence = vocabulary.map(() => 0);
  const negativePresence = vocabulary.map(() => 0);
  vectors.forEach((vector, i) => vector.forEach(entry => { (labels[i] === 1 ? positivePresence : negativePresence)[entry.index]++; }));
  const result: RecommendationState = { fingerprint: recommendationFingerprint(articles, options), trainingFingerprint,
    keywords: vocabulary.map((term, index) => ({ term, weight: model.weights[index] ?? 0, idf: idf[index], positive: positivePresence[index], negative: negativePresence[index] })),
    intercept: model.intercept, accuracy: calibration.accuracy, lowThreshold, highThreshold, updatedAt: new Date().toISOString(), positive, negative, scores: {} };
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    if (articleStatus(article) !== 'unread') continue;
    const vector = vectorizeDocument(documentFor(article), vocabulary, idf);
    if (!vector.length) continue;
    const contributions = vector.map(entry => ({ term: vocabulary[entry.index], weight: entry.value * (effectiveWeights[entry.index] ?? 0) }));
    const logit = contributions.reduce((sum, entry) => sum + entry.weight, model.intercept);
    const score = Math.round(100 / (1 + Math.exp(-logit)));
    result.scores[article.id] = { score, tier: score >= highThreshold ? 'high' : score <= lowThreshold ? 'low' : 'pending',
      terms: contributions.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 6).map(entry => `${entry.weight >= 0 ? '+' : '−'}${entry.term}`) };
    result.scores[article.id].keywordTier = result.scores[article.id].tier;
    if (previous?.fingerprint === result.fingerprint && previous.scores[article.id]?.review?.tier) {
      result.scores[article.id].review = previous.scores[article.id].review;
      result.scores[article.id].tier = previous.scores[article.id].review!.tier!;
    }
    if (i % 25 === 0) await yieldToUi();
  }
  for (const term of options.disabledKeywords) { if (!result.keywords!.some(keyword => keyword.term === term)) result.keywords!.push(previous?.keywords?.find(keyword => keyword.term === term) ?? { term, weight: 0, idf: 1, positive: 0, negative: 0 }); }
  return result;
}
