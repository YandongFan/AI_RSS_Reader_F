const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/ai.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['obsidian'],
}).outputFiles[0].text;

function loadAi(requestUrl = async () => ({})) {
  const sandbox = {
    module: { exports: {} }, exports: {}, Buffer, process,
    setTimeout, clearTimeout, setImmediate,
    require: name => name === 'obsidian' ? { requestUrl } : require(name),
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}

const provider = { kind: 'custom', apiKey: 'test', model: 'test', baseUrl: 'https://model.test' };
const profiles = [{ name: 'A', description: 'alpha', enabled: true }, { name: 'B', description: 'beta', enabled: true }];
const articles = [0, 1].map(id => ({ id: String(id), title: `Paper ${id}`, summary: '', analysis: {}, matchedProfiles: [] }));

test('missing pairs are retried by direction with local IDs and preserve existing evaluations', async () => {
  const requests = [];
  const responses = [
    [{ id: 0, profile_idx: 0, relevant: false, reason: 'original' }, { id: 1, profile_idx: 0, relevant: true, reason: 'original' }, { id: 0, profile_idx: 1, relevant: false, reason: 'original B' }],
    [{ id: 0, profile_idx: 0, relevant: true, reason: 'recovered' }],
  ];
  const api = loadAi(async request => {
    requests.push(JSON.parse(request.body));
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] } };
  });
  const result = await api.analyzeArticles(articles, profiles, provider, 10);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /0: B/);
  assert.match(requests[1].messages[0].content, /ID 0\nTitle: Paper 1/);
  assert.equal(result[0].analysis.B.reason, 'original B');
  assert.equal(result[1].analysis.B.reason, 'recovered');
  assert.equal(result[1].analysis.A.reason, 'original');
});

test('incomplete recovery stops after direction and isolated retries instead of inventing negatives', async () => {
  let calls = 0;
  const api = loadAi(async () => {
    calls++;
    return { status: 200, json: { choices: [{ message: { content: '[]' } }] } };
  });
  await assert.rejects(api.analyzeArticles(articles, profiles, provider, 10), /模型返回结果不完整/);
  assert.equal(calls, 7);
});

test('recovers pair 7/2 after a direction retry still omits it', async () => {
  const papers = Array.from({ length: 8 }, (_, id) => ({ ...articles[0], id: String(id), title: `Paper ${id}` }));
  const directions = [...profiles, { name: 'C', description: 'gamma', enabled: true }];
  let calls = 0;
  const api = loadAi(async request => {
    const prompt = JSON.parse(request.body).messages[0].content;
    calls++;
    const rows = calls === 1 ? papers.flatMap((_, id) => directions.flatMap((__, profile_idx) => id === 7 && profile_idx === 2 ? [] : [{ id, profile_idx, relevant: false, reason: 'complete' }]))
      : calls === 2 ? [] : [{ id: 0, profile_idx: 0, relevant: true, reason: 'recovered C' }];
    if (calls > 1) { assert.match(prompt, /ID 0\nTitle: Paper 7/); assert.match(prompt, /0: C/); }
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(rows) } }] } };
  });
  const result = await api.analyzeArticles(papers, directions, provider, 8);
  assert.equal(calls, 3);
  assert.equal(result[7].analysis.C.reason, 'recovered C');
  assert.deepEqual(Array.from(result[7].matchedProfiles), ['C']);
});

test('persistent missing pair checkpoints complete articles without inventing the missing result', async () => {
  let calls = 0;
  const saved = [];
  const api = loadAi(async () => {
    const rows = ++calls === 1 ? [{ id: 0, profile_idx: 0, relevant: false, reason: 'complete' }] : [];
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(rows) } }] } };
  });
  await assert.rejects(api.analyzeArticles(articles, profiles.slice(0, 1), provider, 2, undefined, async items => saved.push(...items)), /已保存 1 篇/);
  assert.equal(calls, 3);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, '0');
  assert.equal(saved[0].analysis.A.relevant, false);
  assert.deepEqual(articles[1].analysis, {});
});

test('a missing pair in an early batch does not block checkpointing a later batch', async () => {
  let calls = 0;
  const saved = [];
  const api = loadAi(async () => {
    const rows = ++calls <= 3 ? [] : [{ id: 0, profile_idx: 0, relevant: true, reason: 'later complete' }];
    return { status: 200, json: { choices: [{ message: { content: JSON.stringify(rows) } }] } };
  });
  await assert.rejects(api.analyzeArticles(articles, profiles.slice(0, 1), provider, 1, undefined, async items => saved.push(...items)), /已保存 1 篇/);
  assert.equal(calls, 4);
  assert.equal(saved[0].id, '1');
});

test('a later API failure does not undo a completed batch checkpoint', async () => {
  let calls = 0;
  const saved = [];
  const api = loadAi(async () => ++calls === 1
    ? { status: 200, json: { choices: [{ message: { content: '[{"id":0,"profile_idx":0,"relevant":true,"reason":"complete"}]' } }] } }
    : { status: 429, text: 'rate limited' });
  await assert.rejects(api.analyzeArticles(articles, profiles.slice(0, 1), provider, 1, undefined, async items => saved.push(...items)), /429/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].id, '0');
});

test('truncated three-direction output splits directions then articles and remaps local IDs', async () => {
  const directions = [...profiles, { name: 'C', description: 'gamma', enabled: true }];
  const requests = [];
  const api = loadAi(async request => {
    const prompt = JSON.parse(request.body).messages[0].content;
    requests.push(prompt);
    const ids = [...prompt.matchAll(/^ID (\d+)$/gm)];
    const multiProfile = prompt.includes('1: B');
    const direction = /0: ([ABC]) —/.exec(prompt)[1];
    const output = multiProfile || ids.length > 1
      ? '[{"id":0,"profile_idx":0,"relevant":false,"reason":"truncated'
      : JSON.stringify([{ id: 0, profile_idx: 0, relevant: direction === 'C', reason: `${direction}: ${/Title: (Paper \d)/.exec(prompt)[1]}` }]);
    return { status: 200, json: { choices: [{ message: { content: output }, finish_reason: multiProfile ? 'length' : 'stop' }] } };
  });
  const progress = [];
  const result = await api.analyzeArticles(articles, directions, provider, 10, (done, total) => progress.push([done, total]));
  assert.equal(requests.length, 10);
  for (let index = 0; index < result.length; index++) {
    for (const name of ['A', 'B', 'C']) assert.equal(result[index].analysis[name].reason, `${name}: Paper ${index}`);
    assert.deepEqual(Array.from(result[index].matchedProfiles), ['C']);
  }
  assert.deepEqual(progress, [[1, 1]]);
});

test('malformed single-pair output retries once and accepts only a valid replacement', async () => {
  let calls = 0;
  const api = loadAi(async () => ({ status: 200, json: { choices: [{ message: { content: ++calls === 1
    ? '[{"id":0,"profile_idx":0,"relevant":true,"reason":"unescaped " quote"}]'
    : JSON.stringify([{ id: 0, profile_idx: 0, relevant: false, reason: 'valid replacement' }]) } }] } }));
  const result = await api.analyzeArticles(articles.slice(0, 1), profiles.slice(0, 1), provider, 1);
  assert.equal(calls, 2);
  assert.equal(result[0].analysis.A.relevant, false);
  assert.equal(result[0].analysis.A.reason, 'valid replacement');
});

test('persistent malformed output terminates at a single pair without modifying articles', async () => {
  let calls = 0;
  const before = JSON.stringify(articles);
  const api = loadAi(async () => {
    calls++;
    return { status: 200, json: { choices: [{ message: { content: '[{"id":0' } }] } };
  });
  await assert.rejects(api.analyzeArticles(articles, [...profiles, { name: 'C', enabled: true }], provider, 10), /单篇／单方向重试后仍无法解析/);
  assert.equal(calls, 4);
  assert.equal(JSON.stringify(articles), before);
});

test('HTTP errors are not retried as formatting failures', async () => {
  let calls = 0;
  const api = loadAi(async () => { calls++; return { status: 429, text: 'rate limited' }; });
  await assert.rejects(api.analyzeArticles(articles, profiles, provider, 10), /429/);
  assert.equal(calls, 1);
});

test('format recovery also applies to requests for missing pairs', async () => {
  const outputs = [
    JSON.stringify([{ id: 0, profile_idx: 0, relevant: true, reason: 'original' }]),
    '[{"id":',
    JSON.stringify([{ id: 0, profile_idx: 0, relevant: false, reason: 'recovered' }]),
  ];
  const api = loadAi(async () => ({ status: 200, json: { choices: [{ message: { content: outputs.shift() } }] } }));
  const result = await api.analyzeArticles(articles.slice(0, 1), profiles, provider, 10);
  assert.equal(outputs.length, 0);
  assert.equal(result[0].analysis.A.reason, 'original');
  assert.equal(result[0].analysis.B.reason, 'recovered');
});

test('generic text generation preserves Markdown returned by compatible providers', async () => {
  let request;
  const api = loadAi(async value => {
    request = value;
    return { status: 200, json: { choices: [{ message: { content: '## 粗读\n\n物理图像。' } }] }, text: '' };
  });
  const content = await api.generateText({ kind: 'custom', apiKey: 'key', model: 'model', baseUrl: 'https://model.test', codexExecutable: 'codex' }, 'PROMPT');
  assert.equal(content, '## 粗读\n\n物理图像。');
  assert.match(request.url, /\/v1\/chat\/completions$/);
  assert.match(request.body, /PROMPT/);
});

test('Codex alone adds explicit numeric types without changing the Ollama schema', () => {
  const api = loadAi();
  const ollamaSchema = api.ollamaEvaluationSchema(2, 2);
  const codexSchema = api.codexEvaluationSchema(2, 2);
  assert.equal(ollamaSchema.type, 'array');
  assert.equal(codexSchema.type, 'object');
  assert.deepEqual(Array.from(codexSchema.required), ['results']);
  assert.equal(codexSchema.properties.results.minItems, 4);
  assert.equal(codexSchema.properties.results.maxItems, 4);
  for (const item of ollamaSchema.prefixItems) {
    assert.equal('type' in item.properties.id, false);
    assert.equal('type' in item.properties.profile_idx, false);
  }
  assert.equal('prefixItems' in codexSchema.properties.results, false);
  assert.equal(codexSchema.properties.results.items.properties.id.type, 'integer');
  assert.equal(codexSchema.properties.results.items.properties.profile_idx.type, 'integer');
  assert.deepEqual(Array.from(codexSchema.properties.results.items.properties.id.enum), [0, 1]);
  assert.deepEqual(Array.from(codexSchema.properties.results.items.properties.profile_idx.enum), [0, 1]);
});
