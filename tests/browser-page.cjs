const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { parseLinkedomHTML } = require('../node_modules/defuddle/dist/utils/linkedom-compat.js');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['src/browser-page.ts'], bundle: true, write: false, minify: true, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'] }).outputFiles[0].text;
let readTimeoutMs = 15000;
const scheduledDelays = [];
const notices = [];
const sandbox = { module: { exports: {} }, exports: {}, URL,
  setTimeout: (cb, ms) => { scheduledDelays.push(ms); return setTimeout(cb, ms === 15000 ? readTimeoutMs : [700, 1500].includes(ms) ? 0 : ms); }, clearTimeout,
  require: () => ({ Notice: class { constructor(text) { notices.push(text); } hide() {} } }) };
vm.runInNewContext(code, sandbox);
const { matchesArticle, captureBrowserArticle, assertArticlePage, ensureBrowserArticle } = sandbox.module.exports;
const { assertCaptureReady } = sandbox.module.exports;
const target = 'https://www.nature.com/articles/s41928-026-01694-1';
const prefix = 'https://sutd.idm.oclc.org';
const proxy = 'https://www-nature-com.sutd.idm.oclc.org/articles/s41928-026-01694-1';
function tab(url, html, afterCapture) {
  let current = url;
  return { view: { containerEl: parseLinkedomHTML('<html><body><div></div></body></html>').querySelector('div'), webview: {
    getURL: () => current,
    executeJavaScript: async (script) => {
      const document = parseLinkedomHTML(html.startsWith('<html') ? html : `<html><head></head><body>${html}</body></html>`);
      Object.defineProperty(document, 'readyState', { value: 'complete' });
      const result = vm.runInNewContext(script, { URL, location: { href: current }, document });
      if (afterCapture) current = afterCapture;
      return result;
    },
  } } };
}
const app = (...leaves) => ({ workspace: { getLeavesOfType: () => leaves } });

test('recognizes exact publisher article and proxy URL, excluding login and other papers', () => {
  assert.equal(matchesArticle(proxy, target, prefix), true);
  assert.equal(matchesArticle(proxy + '#main', target, prefix), true);
  assert.equal(matchesArticle(prefix + '/login?url=' + target, target, prefix), false);
  assert.equal(matchesArticle(proxy + '-different', target, prefix), false);
  assert.equal(matchesArticle(proxy.replace('www-nature-com', 'evil'), target, prefix), false);
});

test('matches Nature DOI redirects to direct and EZProxy publisher pages without accepting lookalikes', () => {
  const doi = 'https://doi.org/10.1038/s41586-026-10637-x';
  const nature = 'https://www.nature.com/articles/s41586-026-10637-x';
  const proxiedNature = 'https://www-nature-com.sutd.idm.oclc.org/articles/s41586-026-10637-x';
  const proxiedDoi = 'https://doi-org.sutd.idm.oclc.org/10.1038/s41586-026-10637-x';
  for (const current of [doi, nature, `${nature}?utm_source=doi`, proxiedNature, proxiedDoi]) {
    for (const expected of [doi, nature, proxiedNature, proxiedDoi]) {
      assert.equal(matchesArticle(current, expected, prefix), true, `${current} versus ${expected}`);
    }
  }
  for (const current of [
    proxiedNature.replace('10637-x', '10638-x'),
    proxiedNature.replace('www-nature-com', 'evil'),
    `https://unrelated.example/articles/s41586-026-10637-x`,
    `${proxiedNature}/figures/1`,
    `${prefix}/login?url=${doi}`,
  ]) assert.equal(matchesArticle(current, doi, prefix), false, current);
});

test('matches Science DOI redirects to direct and EZProxy publisher pages without accepting lookalikes', () => {
  const doi = 'https://doi.org/10.1126/science.abq8684';
  const science = 'https://www.science.org/doi/10.1126/science.abq8684';
  const scienceFull = 'https://www.science.org/doi/full/10.1126/science.abq8684';
  const proxiedScience = 'https://www-science-org.sutd.idm.oclc.org/doi/10.1126/science.abq8684';
  for (const current of [doi, science, `${science}?utm_source=doi`, scienceFull, proxiedScience]) {
    for (const expected of [doi, science, scienceFull, proxiedScience]) {
      assert.equal(matchesArticle(current, expected, prefix), true, `${current} versus ${expected}`);
    }
  }
  for (const current of [
    proxiedScience.replace('abq8684', 'abq8685'),
    proxiedScience.replace('www-science-org', 'evil'),
    'https://unrelated.example/doi/10.1126/science.abq8684',
    `${proxiedScience}/figures/1`,
    `${prefix}/login?url=${doi}`,
  ]) assert.equal(matchesArticle(current, doi, prefix), false, current);
});

test('captures rendered full text from authenticated tab instead of public or library page', async () => {
  const html = '<html><head><title>Ferroelectricity</title></head><body><h2>Main</h2><p>Stable ferroelectricity in ultrathin films</p></body></html>';
  const page = await captureBrowserArticle(app(tab(target, 'Abstract only'), tab(prefix + '/login', 'SUTD Library'), tab(proxy, html)), target, prefix);
  assert.equal(page.html, html);
  assert.equal(page.url, proxy);
});

test('missing matching article gives instructions, not a login-page fallback', async () => {
  await assert.rejects(captureBrowserArticle(app(tab(prefix + '/login', 'SUTD Library')), target, prefix), /保持标签打开再保存/);
});

test('navigation during capture cannot save the wrong page', async () => {
  await assert.rejects(captureBrowserArticle(app(tab(proxy, 'article', prefix + '/login')), target, prefix), /正在跳转/);
});

test('library interstitial is rejected before title and author extraction', () => {
  const doc = { title: 'SUTD Library', body: { textContent: 'Electronic resources subscribed by SUTD Library are for use by its students' }, querySelector: () => null };
  assert.throws(() => assertArticlePage(doc), /未作为论文正文保存/);
});

test('article metadata is not rejected for a publisher login widget', () => {
  assert.doesNotThrow(() => assertArticlePage({ title: 'Ferroelectricity', body: { textContent: 'Main' }, querySelector: () => ({}) }));
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(url, html = 'article', existing = false) {
  const leaf = tab(url, html);
  let leaves = existing ? [leaf] : [];
  const events = new Set();
  const state = { leaf, opened: undefined, revealed: undefined, reads: 0 };
  const execute = leaf.view.webview.executeJavaScript;
  leaf.view.webview.executeJavaScript = script => { state.reads++; return execute(script); };
  leaf.setViewState = async value => { state.opened = value; };
  leaf.detach = () => { leaves = leaves.filter(item => item !== leaf); for (const cb of [...events]) cb(); };
  state.app = { internalPlugins: { getEnabledPluginById: () => true }, workspace: {
    activeLeaf: undefined,
    getLeavesOfType: () => leaves,
    getLeaf: () => { leaves.push(leaf); return leaf; },
    revealLeaf: async value => { state.revealed = value; },
    on: (_event, cb) => { events.add(cb); return cb; },
    offref: cb => events.delete(cb),
  } };
  state.close = () => { leaves = []; for (const cb of [...events]) cb(); };
  state.events = events;
  state.buttons = () => leaf.view.containerEl.querySelectorAll('button');
  return state;
}

for (const proxyPrefix of ['', prefix]) {
  test(`waits for a click before any capture (${proxyPrefix ? 'proxy' : 'direct'})`, async () => {
    const url = proxyPrefix ? proxy : target;
    const t = setup(url);
    let completed = false;
    const pending = ensureBrowserArticle(t.app, target, proxyPrefix, undefined, { outputFolder: 'Papers/RSS' }).then(page => { completed = true; return page; });
    await tick();
    assert.equal(t.opened.state.url, proxyPrefix ? prefix + '/login?url=' + target : target);
    assert.equal(t.revealed, t.leaf);
    assert.equal(completed, false);
    assert.equal(t.reads, 0);
    const captureBar = t.leaf.view.containerEl.querySelector('.ai-rss-capture-bar');
    assert.deepEqual([...captureBar.children].map(element => element.tagName), ['BUTTON', 'BUTTON', 'LABEL', 'SPAN']);
    assert.equal(captureBar.children[0].textContent, '开始抓取');
    assert.equal(captureBar.children[1].textContent, '取消');
    const folderInput = captureBar.querySelector('input');
    assert.equal(folderInput.value, 'Papers/RSS');
    folderInput.value = 'Papers/Chosen';
    assert.match(captureBar.children[3].textContent, /等待确认/);
    t.buttons()[0].click();
    t.buttons()[0].click();
    const page = await pending;
    assert.equal(page.url, url);
    assert.equal(page.outputFolder, 'Papers/Chosen');
    assert.match(page.html, /article/);
    assert.doesNotMatch(page.html, /开始抓取/);
    assert.equal(t.reads, 1);
    assert.equal(t.buttons().length, 0);
    assert.equal(t.events.size, 0);
  });
}

test('reuses an existing tab but still requires confirmation', async () => {
  const t = setup(target, 'article', true);
  const pending = ensureBrowserArticle(t.app, target);
  await tick();
  assert.equal(t.opened, undefined);
  assert.equal(t.reads, 0);
  t.buttons()[0].click();
  await pending;
});

test('automatic batch mode captures without a click and exposes closing the exact browser tab', async () => {
  const t = setup(target, 'article', true);
  scheduledDelays.length = 0;
  const page = await ensureBrowserArticle(t.app, target, '', undefined, { automatic: true, retryIntervalMs: 700 });
  assert.equal(scheduledDelays.includes(700), true);
  assert.equal(t.reads, 1);
  assert.equal(t.buttons().length, 0);
  assert.equal(t.app.workspace.getLeavesOfType('webviewer').length, 1);
  page.close();
  assert.equal(t.app.workspace.getLeavesOfType('webviewer').length, 0);
});

test('background batch mode opens a new browser tab without taking focus from the reader', async () => {
  const t = setup(target, 'article', false);
  const readerLeaf = { id: 'ai-rss-reader' };
  t.app.workspace.activeLeaf = readerLeaf;
  const page = await ensureBrowserArticle(t.app, target, '', undefined, { automatic: true, background: true });
  assert.equal(t.opened.active, false);
  assert.equal(t.revealed, readerLeaf);
  page.close();
});

test('automatic batch mode retries until APS full text becomes available', async () => {
  const t = setup(aps, '<html><body><div id="fulltext-content"></div></body></html>', true);
  let reads = 0;
  t.leaf.view.webview.executeJavaScript = script => {
    reads++;
    const html = reads === 1
      ? '<html><body><div id="fulltext-content"></div></body></html>'
      : '<html><body><div id="fulltext-content"><p>Full article</p></div></body></html>';
    return tab(aps, html).view.webview.executeJavaScript(script);
  };
  const page = await ensureBrowserArticle(t.app, aps, '', undefined, { automatic: true });
  assert.equal(reads, 2);
  assert.match(page.html, /Full article/);
});

for (const action of ['cancel', 'close', 'unload']) {
  test(`${action} ends waiting and removes controls without capture`, async () => {
    const t = setup(target);
    const controller = new AbortController();
    const pending = ensureBrowserArticle(t.app, target, '', controller.signal);
    const rejected = assert.rejects(pending, /已取消文献采集/);
    await tick();
    if (action === 'cancel') t.buttons()[1].click();
    if (action === 'close') t.close();
    if (action === 'unload') controller.abort();
    await rejected;
    assert.equal(t.reads, 0);
    assert.equal(t.buttons().length, 0);
    assert.equal(t.events.size, 0);
  });
}

const aps = 'https://journals.aps.org/prx/abstract/10.1103/jvv7-z2fq';
test('matches APS DOI resolver redirects, full text paths and proxy addresses', () => {
  const urls = [
    aps,
    'https://link.aps.org/doi/10.1103/jvv7-z2fq',
    'https://doi.org/10.1103/jvv7-z2fq',
    'https://journals.aps.org/prx/fulltext/10.1103/JVV7-Z2FQ/?utm_source=rss',
    'https://journals-aps-org.sutd.idm.oclc.org/prx/abstract/10.1103/jvv7-z2fq',
    'https://link-aps-org.sutd.idm.oclc.org/doi/10.1103/jvv7-z2fq',
  ];
  for (const current of urls) for (const target of urls) assert.equal(matchesArticle(current, target, prefix), true, `${current} versus ${target}`);
  for (const current of [
    aps.replace('jvv7-z2fq', 'szqp-wp6h'),
    aps.replace('journals.aps.org', 'unrelated.example'),
    aps.replace('journals.aps.org', 'journals-aps-org.unrelated.example'),
    prefix + '/login?url=' + aps,
    'https://journals.aps.org/prx/pdf/10.1103/jvv7-z2fq',
  ]) assert.equal(matchesArticle(current, aps, prefix), false);
});

test('captures from embedded webview when view.webview is unavailable', async () => {
  const t = setup(aps, '<html><body><div id="fulltext-content"><p>Full paper</p></div></body></html>');
  const element = t.leaf.view.containerEl.ownerDocument.createElement('webview');
  Object.assign(element, t.leaf.view.webview);
  t.leaf.view.containerEl.appendChild(element);
  delete t.leaf.view.webview;
  const pending = ensureBrowserArticle(t.app, 'https://link.aps.org/doi/10.1103/jvv7-z2fq');
  await tick();
  t.buttons()[0].click();
  assert.equal((await pending).url, aps);
});

test('manual capture can explicitly confirm and override an article address mismatch', async () => {
  const doi = 'https://doi.org/10.1021/acsnano.2c10705';
  const publisherPage = 'https://pubs-acs-org.sutd.idm.oclc.org/ancac3/article/17/5/4134/1241082/2D-Material-Infrared-Photonics-and-Plasmonics?token=private';
  const t = setup(publisherPage);
  const pending = ensureBrowserArticle(t.app, doi);
  await tick();
  t.buttons()[0].click();
  await tick();
  assert.match(t.leaf.view.containerEl.textContent, /地址不匹配.*acsnano\.2c10705.*2D-Material-Infrared-Photonics-and-Plasmonics/);
  assert.doesNotMatch(t.leaf.view.containerEl.textContent, /private/);
  assert.deepEqual([...t.buttons()].map(button => button.textContent), ['开始抓取', '确认正确，继续抓取', '取消']);
  t.buttons()[1].click();
  const page = await pending;
  assert.equal(page.url, publisherPage);
  assert.match(page.html, /article/);
});

test('address mismatch override still rejects a library login page', async () => {
  const t = setup(prefix + '/login', '<html><head><title>SUTD Library</title></head><body>Electronic resources subscribed by SUTD Library</body></html>');
  const pending = ensureBrowserArticle(t.app, target);
  const rejected = assert.rejects(pending, /已取消/);
  await tick();
  t.buttons()[0].click();
  await tick();
  t.buttons()[1].click();
  await tick();
  assert.match(t.leaf.view.containerEl.textContent, /机构登录或提示页面/);
  assert.equal(t.buttons()[1].textContent, '确认正确，继续抓取');
  t.buttons()[2].click();
  await rejected;
});

for (const url of [aps, aps.replace('journals.aps.org', 'journals-aps-org.sutd.idm.oclc.org')]) {
  test(`accepts real APS prose regardless of stale loading flags: ${new URL(url).host}`, () => {
    for (const state of ['pending', 'no', 'error', 'yes', '']) {
      const doc = parseLinkedomHTML(`<html><body><div id="fulltext-content" data-loaded="${state}"><h2>I. INTRODUCTION</h2><p>The full article is visible.</p></div></body></html>`);
      Object.defineProperty(doc, 'readyState', { value: 'interactive' });
      assert.doesNotThrow(() => assertCaptureReady(doc, url));
    }
  });
}

test('does not mistake APS headings, errors, or summary for body paragraphs', () => {
  for (const content of ['', '<h2>Article Text</h2>', '<p class="section-load-error">Loading failed</p>', '<div class="spinner-container"><p>Loading</p></div>']) {
    const doc = parseLinkedomHTML(`<html><body><section id="abstract-section"><p>Abstract is already loaded.</p></section><div id="fulltext-content" data-loaded="yes">${content}</div></body></html>`);
    Object.defineProperty(doc, 'readyState', { value: 'complete' });
    assert.throws(() => assertCaptureReady(doc, aps), /尚无正文段落/);
  }
});

test('accepts APS rendered front container without a loading attribute', () => {
  const doc = parseLinkedomHTML('<html><body><div class="article-fulltext-front"><p>Rendered article.</p></div></body></html>');
  assert.doesNotThrow(() => assertCaptureReady(doc, aps));
});

for (const proxyPrefix of ['', prefix]) {
  test(`APS pending/error/empty full text allows retry before capture (${proxyPrefix ? 'proxy' : 'direct'})`, async () => {
    const url = proxyPrefix ? aps.replace('journals.aps.org', 'journals-aps-org.sutd.idm.oclc.org') : aps;
    const t = setup(url);
    let loaded = 'pending', text = '';
    t.leaf.view.webview.executeJavaScript = script => tab(url, `<html><head><title>APS paper</title></head><body><div id="fulltext-content" data-loaded="${loaded}">${text}</div></body></html>`).view.webview.executeJavaScript(script);
    const pending = ensureBrowserArticle(t.app, aps, proxyPrefix);
    await tick();
    for (const state of ['pending', 'error', 'yes']) {
      loaded = state;
      t.buttons()[0].click();
      await tick();
      assert.equal(t.buttons()[0].disabled, false);
      assert.match(t.leaf.view.containerEl.textContent, /APS 全文/);
    }
    text = '<h2>I. INTRODUCTION</h2><p>Full article text</p>';
    t.buttons()[0].click();
    assert.match((await pending).html, /I\. INTRODUCTION/);
  });
}

test('cancel during capture discards the late snapshot', async () => {
  const t = setup(target);
  let release;
  t.leaf.view.webview.executeJavaScript = () => new Promise(resolve => { release = resolve; });
  const pending = ensureBrowserArticle(t.app, target);
  const rejected = assert.rejects(pending, /已取消文献采集/);
  await tick();
  t.buttons()[0].click();
  await tick();
  t.buttons()[1].click();
  release({ url: target, html: 'article' });
  await rejected;
  await tick();
  assert.equal(t.buttons().length, 0);
});

test('a stalled webview times out visibly and allows a fresh attempt', async () => {
  readTimeoutMs = 5;
  try {
    const t = setup(target);
    let release;
    t.leaf.view.webview.executeJavaScript = () => new Promise(resolve => { release = resolve; });
    const pending = ensureBrowserArticle(t.app, target);
    await tick();
    t.buttons()[0].click();
    assert.equal(t.buttons()[0].textContent, '正在读取…');
    assert.match(notices.at(-1), /已开始抓取/);
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(t.buttons()[0].disabled, false);
    assert.match(t.leaf.view.containerEl.textContent, /读取论文页面超时/);
    assert.match(notices.at(-1), /读取论文页面超时/);
    // The response from the timed-out attempt must not complete confirmation.
    release({ url: target, html: 'stale' });
    await tick();
    assert.equal(t.buttons().length, 2);
    t.leaf.view.webview.executeJavaScript = async () => ({ url: target, html: 'fresh' });
    t.buttons()[0].click();
    assert.equal((await pending).html, 'fresh');
  } finally { readTimeoutMs = 15000; }
});
