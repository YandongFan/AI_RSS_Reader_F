import { requestUrl } from 'obsidian';
import type { AnalysisResult, ProviderSettings, ResearchProfile, RssArticle } from './types';
import { callCodexModel } from './codex-app-server';

interface ModelEvaluation {
  id: number;
  profile_idx: number;
  relevant: boolean;
  reason: string;
}

class EvaluationFormatError extends Error {}

function isEvaluation(value: unknown): value is ModelEvaluation {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Number.isInteger(row.id) && Number.isInteger(row.profile_idx) && typeof row.relevant === 'boolean';
}

function endpoint(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

function isEvaluationArray(value: unknown): value is ModelEvaluation[] {
  return Array.isArray(value) && value.every(isEvaluation);
}

function findEvaluationArray(value: unknown): ModelEvaluation[] | undefined {
  // Ollama JSON mode commonly collapses a one-element array into one object.
  if (isEvaluation(value)) return [value];
  if (isEvaluationArray(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findEvaluationArray(child);
    if (found) return found;
  }
  return undefined;
}

function jsonCandidates(text: string): string[] {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const candidates = cleaned ? [cleaned] : [];
  let start = -1;
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = 0; index < cleaned.length; index += 1) {
    const char = cleaned[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === '[' || char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if ((char === ']' || char === '}') && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) candidates.push(cleaned.slice(start, index + 1));
    }
  }
  return [...new Set(candidates)];
}

function extractJson(text: string): ModelEvaluation[] {
  if (!text.trim()) throw new EvaluationFormatError('模型返回了空内容');
  for (const candidate of jsonCandidates(text)) {
    try {
      const rows = findEvaluationArray(JSON.parse(candidate) as unknown);
      if (rows) return rows;
    } catch {
      // Some compatible APIs add prose around an otherwise valid JSON value.
    }
  }
  throw new EvaluationFormatError('无法解析模型返回的 JSON，内容可能被截断或格式不正确');
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  return contentText(item.text ?? item.content ?? item.value);
}

export function ollamaEvaluationSchema(articleCount: number, profileCount: number): Record<string, unknown> {
  const prefixItems: Record<string, unknown>[] = [];
  for (let id = 0; id < articleCount; id += 1) {
    for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
      prefixItems.push({
        type: 'object',
        required: ['id', 'profile_idx', 'relevant', 'reason'],
        properties: {
          id: { const: id },
          profile_idx: { const: profileIndex },
          relevant: { type: 'boolean' },
          reason: { type: 'string', minLength: 1 },
        },
        additionalProperties: false,
      });
    }
  }
  return {
    type: 'array',
    minItems: prefixItems.length,
    maxItems: prefixItems.length,
    prefixItems,
  };
}

export function codexEvaluationSchema(articleCount: number, profileCount: number): Record<string, unknown> {
  const itemCount = articleCount * profileCount;
  return {
    type: 'object',
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: itemCount,
        maxItems: itemCount,
        items: {
          type: 'object',
          required: ['id', 'profile_idx', 'relevant', 'reason'],
          properties: {
            id: { type: 'integer', enum: Array.from({ length: articleCount }, (_, index) => index) },
            profile_idx: { type: 'integer', enum: Array.from({ length: profileCount }, (_, index) => index) },
            relevant: { type: 'boolean' },
            reason: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

async function callModel(
  provider: ProviderSettings,
  prompt: string,
  articleCount: number,
  profileCount: number,
): Promise<string> {
  if (provider.kind === 'codex') {
    return callCodexModel(
      provider.codexExecutable,
      provider.model,
      `${prompt}\nCodex 结构化输出要求：请将上述结果数组放在对象的 results 字段中。`,
      codexEvaluationSchema(articleCount, profileCount),
    );
  }

  if (provider.kind === 'gemini') {
    const url = endpoint(provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta', `/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`);
    const response = await requestUrl({
      url,
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0 } }),
      throw: false,
    });
    if (response.status >= 400) throw new Error(`Gemini API ${response.status}: ${response.text.slice(0, 160)}`);
    const data = response.json as { candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }> };
    const candidate = data.candidates?.[0];
    const text = contentText(candidate?.content?.parts);
    if (!text) throw new Error(`Gemini 未返回内容${candidate?.finishReason ? `（${candidate.finishReason}）` : ''}`);
    return text;
  }

  if (provider.kind === 'ollama') {
    const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/(v1|api)\/?$/, '');
    const response = await requestUrl({
      url: endpoint(base, '/api/generate'),
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        model: provider.model,
        prompt,
        stream: false,
        format: ollamaEvaluationSchema(articleCount, profileCount),
        options: { temperature: 0 },
      }),
      throw: false,
    });
    if (response.status >= 400) throw new Error(`Ollama ${response.status}: ${response.text.slice(0, 160)}`);
    const data = response.json as { response?: unknown; message?: { content?: unknown }; error?: string };
    const text = contentText(data.response ?? data.message?.content);
    if (!text) throw new Error(data.error ? `Ollama：${data.error}` : 'Ollama 未返回内容');
    return text;
  }

  let base = provider.baseUrl;
  if (!base) base = provider.kind === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
  if (!base.replace(/\/$/, '').endsWith('/v1')) base = endpoint(base, '/v1');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  const response = await requestUrl({
    url: endpoint(base, '/chat/completions'),
    method: 'POST',
    headers,
    body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
    throw: false,
  });
  if (response.status >= 400) throw new Error(`模型 API ${response.status}: ${response.text.slice(0, 160)}`);
  const data = response.json as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown; finish_reason?: string }>;
    output_text?: unknown;
    error?: { message?: string };
  };
  const choice = data.choices?.[0];
  const text = contentText(choice?.message?.content ?? choice?.text ?? data.output_text);
  if (!text) {
    if (data.error?.message) throw new Error(`模型 API：${data.error.message}`);
    throw new Error(`模型 API 未返回内容${choice?.finish_reason ? `（${choice.finish_reason}）` : ''}`);
  }
  return text;
}

function generatedContent(text: string): string {
  for (const candidate of jsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as { content?: unknown };
      if (typeof parsed?.content === 'string' && parsed.content.trim()) return parsed.content.trim();
    } catch {
      // Non-Codex providers normally return Markdown directly.
    }
  }
  return text.trim();
}

/** Generate free-form Markdown for Audio Tutor while preserving the configured provider. */
export async function generateText(provider: ProviderSettings, prompt: string): Promise<string> {
  if (!prompt.trim()) throw new Error('提示词为空');
  if (provider.kind !== 'codex' && !provider.model.trim()) throw new Error('请先配置模型名称');
  if (provider.kind !== 'ollama' && provider.kind !== 'codex' && !provider.apiKey.trim()) throw new Error('请先配置 API Key');

  if (provider.kind === 'codex') {
    const raw = await callCodexModel(provider.codexExecutable, provider.model, prompt, {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string', minLength: 1 } },
      additionalProperties: false,
    });
    const content = generatedContent(raw);
    if (!content) throw new Error('Codex 未返回讲解内容');
    return content;
  }

  if (provider.kind === 'gemini') {
    const url = endpoint(provider.baseUrl || 'https://generativelanguage.googleapis.com/v1beta', `/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(provider.apiKey)}`);
    const response = await requestUrl({
      url, method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2 } }),
      throw: false,
    });
    if (response.status >= 400) throw new Error(`Gemini API ${response.status}: ${response.text.slice(0, 160)}`);
    const data = response.json as { candidates?: Array<{ content?: { parts?: unknown[] }; finishReason?: string }> };
    const candidate = data.candidates?.[0];
    const content = contentText(candidate?.content?.parts).trim();
    if (!content) throw new Error(`Gemini 未返回内容${candidate?.finishReason ? `（${candidate.finishReason}）` : ''}`);
    return content;
  }

  if (provider.kind === 'ollama') {
    const base = (provider.baseUrl || 'http://localhost:11434').replace(/\/(v1|api)\/?$/, '');
    const response = await requestUrl({
      url: endpoint(base, '/api/generate'), method: 'POST', contentType: 'application/json',
      body: JSON.stringify({ model: provider.model, prompt, stream: false, options: { temperature: 0.2 } }),
      throw: false,
    });
    if (response.status >= 400) throw new Error(`Ollama ${response.status}: ${response.text.slice(0, 160)}`);
    const data = response.json as { response?: unknown; message?: { content?: unknown }; error?: string };
    const content = contentText(data.response ?? data.message?.content).trim();
    if (!content) throw new Error(data.error ? `Ollama：${data.error}` : 'Ollama 未返回内容');
    return content;
  }

  let base = provider.baseUrl;
  if (!base) base = provider.kind === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
  if (!base.replace(/\/$/, '').endsWith('/v1')) base = endpoint(base, '/v1');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` };
  const response = await requestUrl({
    url: endpoint(base, '/chat/completions'), method: 'POST', headers,
    body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: prompt }], temperature: 0.2 }),
    throw: false,
  });
  if (response.status >= 400) throw new Error(`模型 API ${response.status}: ${response.text.slice(0, 160)}`);
  const data = response.json as { choices?: Array<{ message?: { content?: unknown }; text?: unknown; finish_reason?: string }>; output_text?: unknown; error?: { message?: string } };
  const choice = data.choices?.[0];
  const content = contentText(choice?.message?.content ?? choice?.text ?? data.output_text).trim();
  if (!content) throw new Error(data.error?.message || `模型 API 未返回内容${choice?.finish_reason ? `（${choice.finish_reason}）` : ''}`);
  return content;
}

function buildPrompt(articles: RssArticle[], profiles: ResearchProfile[]): string {
  const directions = profiles.map((profile, index) => `${index}: ${profile.name} — ${profile.description}`).join('\n');
  const papers = articles.map((article, index) => `ID ${index}\nTitle: ${article.title}\nAbstract: ${article.summary.slice(0, 8000)}`).join('\n---\n');
  return `你是严谨的研究助理。请判断每篇论文是否匹配每一个研究方向。\n\n研究方向：\n${directions}\n\n论文：\n${papers}\n\n只输出 JSON 数组，不要 Markdown。必须包含每一个 paper id 与 profile_idx 的组合，并严格按照 id 从小到大、同一 id 内 profile_idx 从小到大的顺序输出。格式：[{"id":0,"profile_idx":0,"relevant":true,"reason":"完整、具体的中文理由"}]。
reason 必须使用中文，用一句简洁、连贯的话先概括论文研究内容，再说明与当前研究方向的关系：
- relevant 为 true 时，严格采用句式「该论文研究了……，与研究方向中的……相关。」前半句说明具体研究对象、问题或主要发现，后半句点明当前研究方向名称或描述中实际匹配的具体主题，可列出多个主题，不要仅写「与该方向相关」。
- relevant 为 false 时，采用句式「该论文研究了……，与研究方向中的……无明显相关性。」若标题和摘要信息不足以判断，则明确说明「现有信息不足以判断其与研究方向中的……是否相关」，不得编造研究内容或强行建立联系。
省略号仅表示需要填写的内容，实际输出必须替换为有依据的具体内容，不得为空或使用占位符；不要添加标题、列表、评分或额外解释。`;
}

async function requestEvaluations(
  articles: RssArticle[],
  profiles: ResearchProfile[],
  provider: ProviderSettings,
): Promise<ModelEvaluation[]> {
  // Keep transport/authentication failures outside format recovery.
  const raw = await callModel(provider, buildPrompt(articles, profiles), articles.length, profiles.length);
  try {
    return extractJson(raw);
  } catch (error) {
    if (!(error instanceof EvaluationFormatError)) throw error;
    if (profiles.length > 1) {
      const rows: ModelEvaluation[] = [];
      for (let index = 0; index < profiles.length; index += 1) {
        const results = await requestEvaluations(articles, [profiles[index]], provider);
        rows.push(...results.filter(row => row.profile_idx === 0).map(row => ({ ...row, profile_idx: index })));
      }
      return rows;
    }
    if (articles.length > 1) {
      const middle = Math.ceil(articles.length / 2);
      const left = await requestEvaluations(articles.slice(0, middle), profiles, provider);
      const right = await requestEvaluations(articles.slice(middle), profiles, provider);
      return [
        ...left.filter(row => row.id >= 0 && row.id < middle),
        ...right.filter(row => row.id >= 0 && row.id < articles.length - middle).map(row => ({ ...row, id: row.id + middle })),
      ];
    }
    const retry = await callModel(provider, buildPrompt(articles, profiles), 1, 1);
    try {
      return extractJson(retry);
    } catch (retryError) {
      if (!(retryError instanceof EvaluationFormatError)) throw retryError;
      throw new EvaluationFormatError(`单篇／单方向重试后仍无法解析模型返回的 JSON（${profiles[0].name}）。请检查当前模型的结构化输出能力或更换模型后重试。`);
    }
  }
}

export async function analyzeArticles(
  articles: RssArticle[],
  profiles: ResearchProfile[],
  provider: ProviderSettings,
  batchSize: number,
  onBatch?: (completed: number, total: number) => void,
  onResults?: (articles: RssArticle[]) => Promise<void>,
): Promise<RssArticle[]> {
  const activeProfiles = profiles.filter((profile) => profile.enabled);
  if (activeProfiles.length === 0) throw new Error('请至少启用一个研究方向');
  if (provider.kind !== 'codex' && !provider.model.trim()) throw new Error('请先配置模型名称');
  if (provider.kind !== 'ollama' && provider.kind !== 'codex' && !provider.apiKey.trim()) throw new Error('请先配置 API Key');

  const batches: RssArticle[][] = [];
  for (let index = 0; index < articles.length; index += Math.max(1, batchSize)) {
    batches.push(articles.slice(index, index + Math.max(1, batchSize)));
  }

  const output: RssArticle[] = [];
  const incomplete: string[] = [];
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    const rows = await requestEvaluations(batch, activeProfiles, provider);
    const findMissing = () => batch.flatMap((_, articleIndex) => activeProfiles
      .map((__, profileIndex) => ({ articleIndex, profileIndex }))
      .filter(({ articleIndex: id, profileIndex }) => !rows.some((row) => row.id === id && row.profile_idx === profileIndex)));
    // Retry only omitted pairs, with one direction per request and local IDs.
    const initialMissing = findMissing();
    for (let profileIndex = 0; profileIndex < activeProfiles.length; profileIndex += 1) {
      const omitted = initialMissing.filter(item => item.profileIndex === profileIndex);
      if (omitted.length === 0) continue;
      const retryBatch = omitted.map(item => batch[item.articleIndex]);
      const retryRows = await requestEvaluations(retryBatch, [activeProfiles[profileIndex]], provider);
      for (const row of retryRows) {
        if (row.profile_idx === 0 && row.id >= 0 && row.id < omitted.length) {
          rows.push({ ...row, id: omitted[row.id].articleIndex, profile_idx: profileIndex });
        }
      }
    }
    // A direction-level retry can still omit papers. Make one final isolated request per pair.
    for (const { articleIndex, profileIndex } of findMissing()) {
      const raw = await callModel(provider, buildPrompt([batch[articleIndex]], [activeProfiles[profileIndex]]), 1, 1);
      try {
        const row = extractJson(raw).find(item => item.id === 0 && item.profile_idx === 0);
        if (row) rows.push({ ...row, id: articleIndex, profile_idx: profileIndex });
      } catch (error) {
        if (!(error instanceof EvaluationFormatError)) throw error;
      }
    }
    const missing = findMissing();
    const completed: RssArticle[] = [];
    for (let articleIndex = 0; articleIndex < batch.length; articleIndex += 1) {
      if (missing.some(item => item.articleIndex === articleIndex)) continue;
      const article = batch[articleIndex];
      const analysis: Record<string, AnalysisResult> = {};
      const matchedProfiles: string[] = [];
      activeProfiles.forEach((profile, profileIndex) => {
        const row = rows.find((item) => item.id === articleIndex && item.profile_idx === profileIndex);
        const result = { relevant: row?.relevant ?? false, reason: String(row?.reason ?? '模型未返回该项的评估结果') };
        analysis[profile.name] = result;
        if (result.relevant) matchedProfiles.push(profile.name);
      });
      completed.push({ ...article, analysis, matchedProfiles });
    }
    output.push(...completed);
    if (completed.length > 0) await onResults?.(completed);
    if (missing.length > 0) {
      const preview = missing.slice(0, 4).map(({ articleIndex, profileIndex }) => `${articleIndex}/${profileIndex}`).join(', ');
      incomplete.push(`批次 ${batchIndex + 1}：${preview}${missing.length > 4 ? '…' : ''}`);
    }
    onBatch?.(batchIndex + 1, batches.length);
  }
  if (incomplete.length > 0) {
    throw new Error(`模型返回结果不完整，缺少 id/profile_idx（${incomplete.slice(0, 4).join('；')}${incomplete.length > 4 ? '…' : ''}）。${onResults ? `已保存 ${output.length} 篇完整结果，再次更新可重试未完成文章。` : '请重试或更换模型。'}`);
  }
  return output;
}
