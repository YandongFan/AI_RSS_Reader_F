const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/audio-tutor-prompts.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
}).outputFiles[0].text;
const sandbox = {
  module: { exports: {} }, exports: {},
  require: name => name === 'obsidian' ? { normalizePath: value => value } : require(name),
};
vm.runInNewContext(code, sandbox);
const api = sandbox.module.exports;

test('ships every Audio Tutor model prompt as a vault-editable template', () => {
  for (const name of ['rough-reading', 'formula-guide', 'derivation-exercise', 'derivation-hint', 'derivation-check', 'understanding', 'review']) {
    assert.ok(api.defaultAudioTutorPrompt(name).trim(), name);
  }
  assert.match(api.defaultAudioTutorPrompt('rough-reading'), /不展示、不抄写、不朗读任何公式/);
  assert.match(api.defaultAudioTutorPrompt('derivation-check'), /检查用户推导/);
});

test('creates only missing prompt files and preserves user edits', async () => {
  const files = new Map([['AI RSS Reader/rules/audio-tutor/rough-reading.md', 'MY CUSTOM PROMPT']]);
  const directories = new Set();
  const app = { vault: { adapter: {
    exists: path => Promise.resolve(files.has(path) || directories.has(path)),
    mkdir: path => { directories.add(path); return Promise.resolve(); },
    write: (path, value) => { files.set(path, value); return Promise.resolve(); },
    read: path => Promise.resolve(files.get(path)),
  } } };
  await api.ensureAudioTutorPrompts(app);
  assert.equal(files.get('AI RSS Reader/rules/audio-tutor/rough-reading.md'), 'MY CUSTOM PROMPT');
  assert.ok(files.has('AI RSS Reader/rules/audio-tutor/formula-guide.md'));
  assert.ok(files.has('AI RSS Reader/rules/audio-tutor/derivation-check.md'));
});
