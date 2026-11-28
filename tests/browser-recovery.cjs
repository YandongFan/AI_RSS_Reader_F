const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { parseLinkedomHTML } = require('../node_modules/defuddle/dist/utils/linkedom-compat.js');

const code = buildSync({ stdin: { contents: "export * from './src/browser-recovery'; export * from './src/browser-page';", resolveDir: process.cwd() }, bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['obsidian', 'electron'] }).outputFiles[0].text;
const url = 'https://opg.optica.org/prj/fulltext.cfm?uri=prj-14-11-4647';
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  let ready;
  const events = new Map();
  const timers = new Set();
  const calls = [];
  const document = parseLinkedomHTML('<html><body><div></div></body></html>');
  const view = { containerEl: document.querySelector('div'), getState: () => ({ url }), getViewType: () => 'webviewer',
    webview: { getURL: () => url, executeJavaScript() { throw Error('restoration must not read the page'); } } };
  const leaf = { view, isDeferred: false };
  let leaves = [leaf];
  const app = { internalPlugins: { getEnabledPluginById: () => true }, workspace: {
    onLayoutReady: cb => { ready = cb; }, getLeavesOfType: () => leaves,
    on: (name, cb) => { const ref = { name, cb }; events.set(ref, ref); return ref; },
    offref: ref => events.delete(ref),
    getLeaf() { throw Error('restoration must not open tabs'); },
    revealLeaf() { throw Error('restoration must not steal focus'); },
  } };
  const sandbox = { module: { exports: {} }, exports: {}, URL,
    require: () => ({ Notice: class { hide() {} } }), setTimeout, clearTimeout,
    setInterval: cb => { timers.add(cb); return cb; }, clearInterval: cb => timers.delete(cb) };
  vm.runInNewContext(code, sandbox);
  let nextResult = () => Promise.resolve();
  return {
    leaf, app, calls, events, timers,
    install: () => sandbox.module.exports.restoreBrowserCaptureControls(app, () => 'Papers/Default', (chosen, folder) => {
      calls.push({ chosen, folder }); return nextResult(chosen, folder);
    }),
    capture: (options = {}) => sandbox.module.exports.ensureBrowserArticle(app, url, '', undefined, { leaf, ...options }),
    onStart: callback => { nextResult = callback; },
    ready: () => ready(), poll: () => [...timers].forEach(cb => cb()),
    event: name => [...events.values()].filter(ref => ref.name === name).forEach(ref => ref.cb()),
    close: () => { leaves = []; },
    fail: error => { nextResult = () => Promise.reject(error); },
    bars: () => leaf.view.containerEl.querySelectorAll('.ai-rss-capture-bar'),
  };
}

test('restart and plugin reload restore controls once and remain idle until the user clicks Start', async () => {
  const t = setup();
  const dispose = t.install();
  assert.equal(t.bars().length, 0);
  t.ready();
  t.event('layout-change'); t.event('active-leaf-change'); t.poll();
  assert.equal(t.bars().length, 1);
  assert.equal(t.calls.length, 0);
  assert.deepEqual([...t.bars()[0].querySelectorAll('button')].map(button => button.textContent), ['开始抓取', '取消']);
  assert.equal(t.bars()[0].querySelector('input').value, 'Papers/Default');
  dispose();
  assert.equal(t.bars().length, 0);
  assert.equal(t.events.size, 0); assert.equal(t.timers.size, 0);
  const disposeReload = t.install();
  t.ready();
  const start = t.bars()[0].querySelector('button');
  t.bars()[0].querySelector('input').value = 'Papers/Chosen';
  start.click(); start.click();
  await tick();
  assert.deepEqual(t.calls, [{ chosen: t.leaf, folder: 'Papers/Chosen' }]);
  t.poll();
  assert.equal(t.bars().length, 0);
  disposeReload();
});

test('deferred tabs and delayed webviews get controls once ready without forcing them to load', () => {
  const t = setup();
  t.leaf.isDeferred = true;
  const dispose = t.install(); t.ready();
  assert.equal(t.bars().length, 0);
  t.leaf.isDeferred = false;
  t.leaf.view.webview.getURL = () => { throw Error('webview not yet attached'); };
  t.poll();
  assert.equal(t.bars().length, 1);
  t.bars()[0].remove(); // Web Viewer's late initial render replaces its container children.
  t.poll();
  assert.equal(t.bars().length, 1);
  assert.equal(t.calls.length, 0);
  dispose();
});

test('cancel, tab close and unload remove restored UI without starting a save', () => {
  for (const action of ['cancel', 'close', 'unload']) {
    const t = setup(); const dispose = t.install(); t.ready();
    if (action === 'cancel') t.bars()[0].querySelectorAll('button')[1].click();
    if (action === 'close') t.close();
    if (action === 'unload') dispose();
    t.event('layout-change'); t.poll();
    assert.equal(t.bars().length, 0, action);
    assert.equal(t.calls.length, 0, action);
    dispose();
  }
});

test('unload before layout readiness never attaches controls or listeners later', () => {
  const t = setup(); const dispose = t.install(); dispose(); t.ready();
  assert.equal(t.bars().length, 0);
  assert.equal(t.events.size, 0); assert.equal(t.timers.size, 0);
});

test('existing capture sessions are not duplicated and non-web URLs are ignored', () => {
  const t = setup();
  const existing = t.leaf.view.containerEl.ownerDocument.createElement('div');
  existing.className = 'ai-rss-capture-bar'; t.leaf.view.containerEl.append(existing);
  const dispose = t.install(); t.ready(); t.poll();
  assert.equal(t.bars().length, 1); assert.equal(t.bars()[0], existing);
  dispose(); assert.equal(t.bars()[0], existing);
  existing.remove();
  t.leaf.view.webview.getURL = () => 'file:///private.pdf';
  const disposeAgain = t.install(); t.ready(); t.poll();
  assert.equal(t.bars().length, 0);
  disposeAgain();
});

test('invalid folders never start capture; save failure offers retry; cancellation stays dismissed', async () => {
  const t = setup(); const dispose = t.install(); t.ready();
  t.bars()[0].querySelector('input').value = '../outside';
  t.bars()[0].querySelector('button').click();
  assert.equal(t.calls.length, 0);
  t.bars()[0].querySelector('input').value = 'Papers/Chosen';
  t.fail(Error('disk unavailable'));
  t.bars()[0].querySelector('button').click(); await tick();
  assert.equal(t.bars().length, 1);
  assert.match(t.bars()[0].textContent, /disk unavailable/);
  t.fail(Error('已取消文献采集'));
  t.bars()[0].querySelector('button').click(); await tick(); t.poll();
  assert.equal(t.bars().length, 0);
  dispose();
});

test('restored controls hand one confirmed click to the real capture flow and never start it during restoration', async () => {
  const t = setup(); let reads = 0; let captured;
  t.leaf.view.webview.executeJavaScript = async () => { reads++; return { url, html: '<html>Restored paper</html>' }; };
  t.onStart(async (_leaf, folder) => {
    captured = await t.capture({ startImmediately: true, outputFolder: folder });
  });
  const dispose = t.install(); t.ready(); t.poll(); await tick();
  assert.equal(reads, 0);
  t.bars()[0].querySelector('input').value = 'Papers/Restored';
  t.bars()[0].querySelector('button').click();
  await tick();
  assert.equal(reads, 1);
  assert.equal(captured.outputFolder, 'Papers/Restored');
  assert.equal(t.calls.length, 1);
  t.poll();
  assert.equal(t.bars().length, 0);
  dispose();
});

test('opening an article from the reader takes over the idle restored bar without duplicating or resurrecting it', async () => {
  const t = setup(); const dispose = t.install(); t.ready();
  const pending = t.capture({ outputFolder: 'Papers/Reader' });
  const cancelled = assert.rejects(pending, /已取消/);
  assert.equal(t.bars().length, 1);
  assert.equal(t.bars()[0].hasAttribute('data-ai-rss-restored'), false);
  t.poll();
  assert.equal(t.bars().length, 1);
  t.bars()[0].querySelectorAll('button')[1].click();
  await cancelled;
  t.poll();
  assert.equal(t.bars().length, 0);
  dispose();
});
