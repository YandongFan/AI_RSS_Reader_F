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
