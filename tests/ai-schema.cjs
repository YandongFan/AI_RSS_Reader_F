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

test('incomplete recovery stops after one retry per direction instead of inventing negatives', async () => {
  let calls = 0;
  const api = loadAi(async () => {
    calls++;
    return { status: 200, json: { choices: [{ message: { content: '[]' } }] } };
  });
  await assert.rejects(api.analyzeArticles(articles, profiles, provider, 10), /模型返回结果不完整/);
  assert.equal(calls, 3);
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
