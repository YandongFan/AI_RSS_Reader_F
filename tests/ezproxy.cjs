const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({ entryPoints: ['src/ezproxy.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'] }).outputFiles[0].text;

function setup({ enabled = true, remote = true, cookies = [] } = {}) {
  const removed = [], notices = [], partitions = [], buttons = [], queries = [];
  const session = { cookies: { get: async (filter) => { queries.push(filter); return cookies; }, remove: async (...args) => removed.push(args) } };
  const sandbox = { exports: {}, module: { exports: {} }, URL, require: (id) => id === 'obsidian'
    ? { Notice: class { constructor(message) { notices.push(message); } } }
    : { remote: remote ? { session: { fromPartition: (partition) => { partitions.push(partition); return session; } } } : undefined } };
  vm.runInNewContext(code, sandbox);
  const api = sandbox.module.exports;
  const banner = { removed: false, createSpan() {}, remove() { this.removed = true; }, createEl(tag, options) {
    const button = { text: options.text, disabled: false, addEventListener(event, callback) { this.click = callback; } };
    buttons.push(button); return button;
  } };
  let listener, leaves;
  const leaf = { view: { getViewType: () => 'webviewer', getState: () => leaf.state.state, webview: { getURL: () => leaf.currentUrl || leaf.state.state.url }, containerEl: { createDiv: () => banner } },
    async setViewState(state) { this.state = state; }, detach() { leaves = []; } };
  leaves = [leaf];
  const app = { getWebviewPartition: () => 'persist:vault-test', internalPlugins: { getEnabledPluginById: () => enabled },
    setting: { close() { this.closed = true; } }, workspace: { getLeaf: () => leaf, revealLeaf: async () => {},
      on(event, callback) { listener = callback; return callback; }, offref() { listener = undefined; }, getLeavesOfType: () => leaves } };
  return { api, app, leaf, buttons, banner, notices, removed, partitions, queries, close() { leaf.detach(); listener?.(); } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const prefix = 'https://school.example';
const cookie = { name: 'ticket', value: 'test', domain: '.school.example', path: '/', secure: true };

test('arXiv pages, PDFs, subdomains and DOI links bypass proxy and cookies', async () => {
  const t = setup();
  for (const url of ['https://arxiv.org/abs/1706.03762', 'https://arxiv.org/pdf/1706.03762', 'https://export.arxiv.org/api/query?id_list=1706.03762', 'https://doi.org/10.48550/arXiv.1706.03762']) {
    assert.equal(t.api.proxyUrl(url, prefix), url);
    assert.equal(await t.api.readProxyCookies(t.app, prefix, url), '');
  }
  assert.equal(t.queries.length, 0);
  for (const url of ['https://arxiv.org.evil.example/paper','https://notarxiv.org/paper','https://doi.org/10.1002/adma.74896']) assert.equal(t.api.bypassEzProxy(url), false);
});

test('normalizes bare host and templates; rejects lookalike proxy domains', () => {
  const { api } = setup();
  assert.equal(api.proxyUrl('https://paper.example/a?x=1', prefix), prefix + '/login?url=https://paper.example/a?x=1');
  assert.equal(api.proxyUrl('https://paper.example', prefix + '/login?url=$@'), prefix + '/login?url=https://paper.example');
  const article = 'https://www.nature.com/articles/s41928-026-01694-1';
  for (const template of ['https://sutd.idm.oclc.org', 'https://sutd.idm.oclc.org/login?url=', 'https://sutd.idm.oclc.org/login?url=$@']) {
    assert.equal(api.proxyUrl(article, template), 'https://sutd.idm.oclc.org/login?url=' + article);
  }
  assert.equal(api.proxyUrl('https://publisher.school.example/paper', prefix), 'https://publisher.school.example/paper');
  assert.equal(api.isProxyHost('evilschool.example', 'school.example'), false);
  assert.throws(() => api.proxyUrl('https://paper.example', 'javascript:alert(1)'));
});

test('opens native Web Viewer and records cookies through remote, with no electron.session', async () => {
  const t = setup({ cookies: [cookie] });
  let saved;
  const pending = new t.api.EzProxyLogin().open(t.app, prefix, 'https://paper.example', async (value) => { saved = value; });
  await tick();
  assert.equal(t.leaf.state.type, 'webviewer');
  assert.equal(t.app.setting.closed, true);
  assert.equal(saved, undefined);
  t.leaf.currentUrl = 'https://publisher.school.example/article';
  t.buttons[0].click();
  await pending;
  assert.equal(saved, 'ticket=test');
  assert.ok(t.partitions.every((p) => p === 'persist:vault-test'));
  assert.equal(t.banner.removed, true);
});

test('closing a login tab cancels and never records credentials', async () => {
  const t = setup();
  const pending = new t.api.EzProxyLogin().open(t.app, prefix, 'https://paper.example', async () => assert.fail('unexpected save'));
  const rejection = assert.rejects(pending, /已取消/);
  await tick(); t.close(); await rejection;
  assert.equal(t.banner.removed, true);
});

test('remaining on login page allows retry; unloading cancels the pending login', async () => {
  const t = setup(), login = new t.api.EzProxyLogin();
  const pending = login.open(t.app, prefix, 'https://paper.example', async () => assert.fail('unexpected save'));
  const rejection = assert.rejects(pending, /已取消/);
  await tick(); t.buttons[0].click(); await tick();
  assert.equal(t.buttons[0].disabled, false);
  assert.match(t.notices[0], /仍在机构登录页面/);
  login.dispose(); await rejection;
});

test('completion uses the redirected publisher URL and accepts parent-domain HttpOnly cookies', async () => {
  const t = setup({ cookies: [{ ...cookie, domain: '.idm.oclc.org', httpOnly: true }] });
  const target = 'https://www.nature.com/articles/s41928-026-01694-1';
  const current = 'https://www-nature-com.sutd.idm.oclc.org/articles/s41928-026-01694-1';
  let saved;
  const pending = new t.api.EzProxyLogin().open(t.app, 'https://sutd.idm.oclc.org', target, async (value) => { saved = value; });
  await tick();
  t.leaf.currentUrl = current;
  t.buttons[0].click(); await pending;
  assert.equal(saved, 'ticket=test');
  assert.equal(t.queries.at(-1).url, current);
  assert.equal(t.notices.some((message) => message.includes('未检测到')), false);
});

test('user can confirm a proxy article without a cookie at the login host', async () => {
  const t = setup();
  let saved = false;
  const pending = new t.api.EzProxyLogin().open(t.app, prefix, 'https://paper.example', async () => { saved = true; });
  await tick(); t.leaf.currentUrl = 'https://publisher.school.example/article';
  t.buttons[0].click(); await pending;
  assert.equal(saved, true);
});

test('completion rejects an external SSO page or lookalike proxy host', async () => {
  for (const current of ['https://sso.example/login', 'https://evilschool.example/article']) {
    const t = setup({ cookies: [cookie] }), login = new t.api.EzProxyLogin();
    const pending = login.open(t.app, prefix, 'https://paper.example', async () => assert.fail('unexpected save'));
    const rejection = assert.rejects(pending, /已取消/);
    await tick(); t.leaf.currentUrl = current; t.buttons[0].click(); await tick();
    assert.match(t.notices[0], /还未返回机构代理/);
    login.dispose(); await rejection;
  }
});

test('request cookies exclude unrelated domains, paths, and host-only parent cookies', async () => {
  const t = setup({ cookies: [cookie, { ...cookie, name: 'other', domain: 'other.example' },
    { ...cookie, name: 'admin', path: '/admin' }, { ...cookie, name: 'host', hostOnly: true }] });
  assert.equal(await t.api.readProxyCookies(t.app, prefix, 'https://publisher.school.example/article'), 'ticket=test');
});

test('disabled core plugin and unavailable remote return actionable errors', async () => {
  for (const [options, message] of [[{ enabled: false }, /核心插件/], [{ remote: false }, /重启或升级/]]) {
    const t = setup(options);
    await assert.rejects(new t.api.EzProxyLogin().open(t.app, prefix, 'https://paper.example', async () => {}), message);
    assert.equal(t.leaf.state, undefined);
  }
});

test('clear removes only proxy cookies and preserves unrelated sites', async () => {
  const t = setup({ cookies: [cookie, { ...cookie, domain: 'publisher.school.example' }, { ...cookie, domain: 'evilschool.example' }, { ...cookie, domain: 'sso.example' }] });
  assert.equal(await t.api.readProxyCookies(t.app, prefix), 'ticket=test');
  await t.api.clearProxyCookies(t.app, prefix);
  assert.deepEqual(t.removed, [['https://school.example/', 'ticket'], ['https://publisher.school.example/', 'ticket']]);
});
