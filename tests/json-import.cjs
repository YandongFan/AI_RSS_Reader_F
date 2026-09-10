const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const code = transformSync(readFileSync('src/json-import.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const sandbox = { module: { exports: {} }, exports: {}, require };
vm.runInNewContext(code, sandbox);
const { pickJsonFile } = sandbox.module.exports;

function setup(file) {
  const listeners = new Map();
  const input = {
    files: file ? [file] : [], style: {}, connected: false, clicked: false, removed: false,
    addEventListener(name, handler) { listeners.set(name, handler); },
    click() { this.clicked = true; assert.equal(this.connected, true); },
    remove() { this.removed = true; this.connected = false; },
  };
  const document = {
    createElement(tag) { assert.equal(tag, 'input'); return input; },
    body: { appendChild(element) { assert.equal(element, input); input.connected = true; } },
  };
  return { container: { ownerDocument: document }, document, input, dispatch: name => listeners.get(name)?.() };
}

test('attaches the file input before opening it and imports selected JSON', async () => {
  const fixture = setup({ text: async () => '{"papers":2}' });
  let imported;
  pickJsonFile(fixture.container, async value => { imported = value; }, () => assert.fail('unexpected error'));
  assert.equal(fixture.input.clicked, true);
  fixture.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(imported.papers, 2);
  assert.equal(fixture.input.removed, true);
});

test('reports invalid JSON and removes the temporary input', async () => {
  const fixture = setup({ text: async () => '{invalid' });
  let error;
  pickJsonFile(fixture.container, async () => {}, caught => { error = caught; });
  fixture.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(error?.name, 'SyntaxError');
  assert.equal(fixture.input.removed, true);
});

test('removes the temporary input when the picker is cancelled', () => {
  const fixture = setup();
  pickJsonFile(fixture.container, async () => {}, () => {});
  fixture.dispatch('cancel');
  assert.equal(fixture.input.removed, true);
});
