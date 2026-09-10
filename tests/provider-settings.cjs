const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/provider-settings.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
}).outputFiles[0].text;

function loadProviderSettings() {
  const sandbox = { module: { exports: {} }, exports: {}, require };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}

test('migrates the legacy active provider without losing its settings', () => {
  const api = loadProviderSettings();
  const configs = api.normalizeProviderConfigs({
    kind: 'deepseek', apiKey: 'deep-key', model: 'deep-custom', baseUrl: 'https://deep.example/v1', codexExecutable: 'codex',
  });
  assert.equal(configs.deepseek.apiKey, 'deep-key');
  assert.equal(configs.deepseek.model, 'deep-custom');
  assert.equal(configs.deepseek.baseUrl, 'https://deep.example/v1');
  assert.equal(configs.openai.model, 'gpt-4o-mini');
  assert.equal(configs.codex.codexExecutable, 'codex');
});

test('switching providers restores every provider own API key, model and URL', () => {
  const api = loadProviderSettings();
  const settings = {
    provider: { kind: 'openai', apiKey: 'open-key', model: 'open-model', baseUrl: 'https://open.example/v1', codexExecutable: 'codex' },
    providerConfigs: api.normalizeProviderConfigs(),
  };
  api.switchProvider(settings, 'deepseek');
  settings.provider.apiKey = 'deep-key';
  settings.provider.model = 'deep-model';
  settings.provider.baseUrl = 'https://deep.example/v1';
  api.switchProvider(settings, 'codex');
  settings.provider.model = 'gpt-5.6-sol';
  settings.provider.codexExecutable = 'C:\\Tools\\codex.exe';
  api.switchProvider(settings, 'openai');
  assert.equal(settings.provider.apiKey, 'open-key');
  assert.equal(settings.provider.model, 'open-model');
  assert.equal(settings.provider.baseUrl, 'https://open.example/v1');
  api.switchProvider(settings, 'deepseek');
  assert.equal(settings.provider.apiKey, 'deep-key');
  assert.equal(settings.provider.model, 'deep-model');
  assert.equal(settings.provider.baseUrl, 'https://deep.example/v1');
  api.switchProvider(settings, 'codex');
  assert.equal(settings.provider.model, 'gpt-5.6-sol');
  assert.equal(settings.provider.codexExecutable, 'C:\\Tools\\codex.exe');
});

test('saved provider configs never contain ChatGPT OAuth token fields', () => {
  const api = loadProviderSettings();
  const serialized = JSON.stringify(api.normalizeProviderConfigs());
  assert.equal(serialized.includes('accessToken'), false);
  assert.equal(serialized.includes('refreshToken'), false);
});
