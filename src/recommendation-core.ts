/*!
MIT License

Copyright (c) 2026 ApoclyReol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/
// Ported from ApoclyReol/Academic_RSS_Reader-Obsidian (MIT). See THIRD_PARTY_NOTICES.md.
interface SparseEntry { index: number; value: number; }
export type SparseVector = SparseEntry[];
interface TrainedModel { weights: number[]; intercept: number; }
const STOPWORDS = new Set(
  `
  a an and are as at be been by can could for from has have how in into is it its
  may might more most new not of on or our paper research study than that the their
  these this through to toward using via was we were what when where which while who
  with would results method analysis based effects evidence approach role model data
  一种 一个 以及 通过 对于 关于 中的 研究 分析 基于 影响 作用 方法 模型 数据 结果
  `.trim().split(/\s+/),
);


export function tokenize(text: string): string[] {
  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locale?: string,
        options?: { granularity: "word" },
      ) => {
        segment(value: string): Iterable<{
          segment: string;
          isWordLike?: boolean;
        }>;
      };
    }
  ).Segmenter;
  if (typeof Segmenter === "function") {
    const segmenter = new Segmenter(undefined, {
      granularity: "word",
    });
    const segmented = [...segmenter.segment(text.toLocaleLowerCase())]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
    if (segmented.length > 0) {
      return segmented
        .map(normalizeSegmentedToken)
        .filter((token): token is string => token !== null);
    }
  }
  return fallbackTokens(text);
}

function normalizeSegmentedToken(value: string): string | null {
  const normalized = value.toLocaleLowerCase().replaceAll("_", "-");
  if (
    normalized.length < 2 ||
    STOPWORDS.has(normalized) ||
    /^\d+$/.test(normalized)
  ) {
    return null;
  }
  return /^[a-z][a-z0-9-]*$|^[\u3400-\u9fff]+$/u.test(normalized)
    ? normalized
    : null;
}

function fallbackTokens(text: string): string[] {
  const parts =
    text.toLocaleLowerCase().match(/[a-z][a-z0-9_-]{1,}|[\u3400-\u9fff]+/g) ??
    [];
  const tokens: string[] = [];
  for (const part of parts) {
    if (/^[\u3400-\u9fff]+$/.test(part)) {
      if (part.length === 2) {
        tokens.push(part);
      } else {
        for (let index = 0; index < part.length - 1; index += 1) {
          tokens.push(part.slice(index, index + 2));
        }
      }
    } else {
      const normalized = part.replaceAll("_", "-");
      if (!STOPWORDS.has(normalized) && !/^\d+$/.test(normalized)) {
        tokens.push(normalized);
      }
    }
  }
  return tokens.filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}


export function extractDocumentTerms(document: string): string[] {
  const base = tokenize(document);
  const structured =
    document.toLocaleLowerCase().match(
      /(?:journal|feed|author|freshness):[^\s]+/g,
    ) ?? [];
  const ngrams = [...base, ...structured];
  const lexical = base.filter((token) => !token.includes(":"));
  for (let index = 0; index < lexical.length - 1; index += 1) {
    const left = lexical[index] ?? "";
    const right = lexical[index + 1] ?? "";
    if (isLatinToken(left) && isLatinToken(right)) {
      ngrams.push(`${left} ${right}`);
    }
  }
  return ngrams;
}

export function vectorizeDocument(
  document: string,
  vocabulary: string[],
  idf: number[],
): SparseVector {
  const indexByToken = new Map(
    vocabulary.map((token, index) => [token, index]),
  );
  const counts = new Map<string, number>();
  for (const token of extractDocumentTerms(document)) {
    if (indexByToken.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const vector: SparseVector = [];
  let squaredNorm = 0;
  for (const [token, count] of counts) {
    const index = indexByToken.get(token);
    if (index === undefined) {
      continue;
    }
    const value = (1 + Math.log(count)) * (idf[index] ?? 1);
    vector.push({ index, value });
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  return norm > 0
    ? vector.map((entry) => ({
        index: entry.index,
        value: entry.value / norm,
      }))
    : vector;
}


function isLatinToken(value: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(value);
}


export async function trainLogisticCore(
  vectors: SparseVector[],
  labels: number[],
  trainingIndexes: number[],
  yieldToUi: () => Promise<void>,
): Promise<TrainedModel> {
  let maximumIndex = -1;
  for (const vector of vectors) {
    for (const entry of vector) {
      if (entry.index > maximumIndex) {
        maximumIndex = entry.index;
      }
    }
  }
  const width = maximumIndex + 1;
  const weights = new Array<number>(width).fill(0);
  let intercept = 0;
  const learningRate = 0.4;
  const total = trainingIndexes.length;
  const positiveCount = trainingIndexes.filter((index) => labels[index] === 1).length;
  const negativeCount = total - positiveCount;
  const positiveWeight = total / (2 * Math.max(1, positiveCount));
  const negativeWeight = total / (2 * Math.max(1, negativeCount));
  const sigmoid = (value: number): number => {
    if (value >= 0) {
      return 1 / (1 + Math.exp(-value));
    }
    const exp = Math.exp(value);
    return exp / (1 + exp);
  };
  const dot = (vector: SparseVector): number => {
    let result = 0;
    for (const entry of vector) {
      result += entry.value * (weights[entry.index] ?? 0);
    }
    return result;
  };
  for (let iteration = 0; iteration < 350; iteration += 1) {
    if (iteration % 5 === 0) await yieldToUi();
    const gradient = new Array<number>(weights.length).fill(0);
    let interceptGradient = 0;
    for (const row of trainingIndexes) {
      const vector = vectors[row] ?? [];
      const label = labels[row] ?? 0;
      const sampleWeight = label === 1 ? positiveWeight : negativeWeight;
      const probability = sigmoid(dot(vector) + intercept);
      const error = (probability - label) * sampleWeight;
      interceptGradient += error;
      for (const entry of vector) {
        gradient[entry.index] =
          (gradient[entry.index] ?? 0) + error * entry.value;
      }
    }
    for (let column = 0; column < weights.length; column += 1) {
      const regularized =
        (gradient[column] ?? 0) / total + 0.01 * (weights[column] ?? 0);
      weights[column] = (weights[column] ?? 0) - learningRate * regularized;
    }
    intercept -= learningRate * interceptGradient / total;
  }
  return { weights, intercept };
}


function dotSparse(left: SparseVector, right: number[]): number {
  let result = 0;
  for (const entry of left) {
    result += entry.value * (right[entry.index] ?? 0);
  }
  return result;
}

export function stratifiedSplit(labels: number[]): {
  training: number[];
  validation: number[];
} {
  const groups = [0, 1].map((label) =>
    labels
      .map((value, index) => ({ value, index }))
      .filter((entry) => entry.value === label)
      .map((entry) => entry.index),
  );
  if (groups.some((group) => group.length < 5)) {
    return {
      training: labels.map((_, index) => index),
      validation: [],
    };
  }
  const validation = groups.flatMap((group) =>
    group.filter((_, index) => index % 5 === 0),
  );
  const validationSet = new Set(validation);
  return {
    training: labels
      .map((_, index) => index)
      .filter((index) => !validationSet.has(index)),
    validation,
  };
}

export function calibrateThresholds(
  vectors: SparseVector[],
  labels: number[],
  model: TrainedModel,
  validation: number[],
): {
  accuracy: number | null;
  lowThreshold: number;
  highThreshold: number;
} {
  if (validation.length === 0) {
    return { accuracy: null, lowThreshold: 30, highThreshold: 70 };
  }
  let bestCut = 50;
  let bestCorrect = -1;
  for (let cut = 10; cut <= 90; cut += 1) {
    const correct = validation.filter((index) => {
      const probability =
        sigmoid(
          dotSparse(vectors[index] ?? [], model.weights) +
            model.intercept,
        ) * 100;
      return Number(probability >= cut) === (labels[index] ?? 0);
    }).length;
    if (
      correct > bestCorrect ||
      (correct === bestCorrect &&
        Math.abs(cut - 50) < Math.abs(bestCut - 50))
    ) {
      bestCut = cut;
      bestCorrect = correct;
    }
  }
  return {
    accuracy: bestCorrect / validation.length,
    lowThreshold: Math.max(0, bestCut - 10),
    highThreshold: Math.min(100, bestCut + 10),
  };
}


function sigmoid(value: number): number {
  if (value >= 0) {
    return 1 / (1 + Math.exp(-value));
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}
