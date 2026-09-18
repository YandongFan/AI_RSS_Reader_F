const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { DOMParser } = require('linkedom');
class BrowserDOMParser extends DOMParser {
  parseFromString(value, type) {
    // Linkedom does not synthesize html/body for fragments as browsers do.
    return super.parseFromString(type === 'text/html' && !/<html/i.test(value) ? `<html><body>${value}</body></html>` : value, type);
  }
}

function load(name, imports = {}, document) {
  const code = buildSync({ entryPoints: [`src/${name}.ts`], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'electron'] }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', 'DOMParser', 'document', code)(mod, mod.exports, name => imports[name] ?? require(name), BrowserDOMParser, document);
  return mod.exports;
}
const { articleStatus, setArticleStatus, sortArticles, isCurated, recommendationArticles } = load('article-state');
const { pruneExpiredArticles } = load('retention');
const { extractArticleImage, safeImageUrl } = load('article-image');
const { buildRecommendations, recommendationFingerprint } = load('recommendation');
const paper = (id, status = 'unread', title = id) => ({ id, title, status, read: status !== 'unread', source: '', summary: '', link: '', published: '', fetchedAt: '2026-09-09', analysis: {}, matchedProfiles: [] });

test('legacy state migration respects saved notes and explicit categories', () => {
  assert.equal(articleStatus({ read: false }), 'unread');
  assert.equal(articleStatus({ read: true }), 'archived');
  assert.equal(articleStatus({ read: false, savedPath: 'paper.md' }), 'archived');
  assert.equal(articleStatus({ status: 'interested', read: true }), 'interested');
});

test('hidden expires, interested/archive remain, and restored unread starts a new clock', () => {
  const now = Date.parse('2026-09-09');
  const items = ['hidden', 'interested', 'archived'].map(status => {
    const value = paper(status); setArticleStatus(value, status, now - 40 * 86400000); return value;
  });
  const result = pruneExpiredArticles(items, { readRetentionDays: 30, unreadRetentionDays: 90 }, now);
  assert.deepEqual(result.articles.map(articleStatus), ['expired', 'interested', 'archived']);
  setArticleStatus(result.articles[0], 'unread', now);
  assert.equal(pruneExpiredArticles(result.articles, { readRetentionDays: 30, unreadRetentionDays: 90 }, now).articles[0].status, 'unread');
  assert.equal(result.articles[0].read, false);
});

test('RSS image extraction handles media, Atom, HTML, relative URLs and rejects decorative/unsafe images', () => {
  const parse = xml => new DOMParser().parseFromString(`<item>${xml}</item>`, 'text/xml').documentElement;
  assert.equal(extractArticleImage(parse('<media:content xmlns:media="http://search.yahoo.com/mrss/" type="image/jpeg" url="/figure.jpg"/>'), 'https://example.org/paper'), 'https://example.org/figure.jpg');
  assert.equal(extractArticleImage(parse('<link rel="enclosure" type="image/png" href="//example.org/figure.png"/>'), 'https://example.org'), 'https://example.org/figure.png');
  assert.equal(extractArticleImage(parse('<description><![CDATA[<img width="1" src="https://example.org/a.png"><img src="https://example.org/logo.png"><img src="/figure.png">]]></description>'), 'https://example.org/paper'), 'https://example.org/figure.png');
  assert.equal(extractArticleImage(parse('<enclosure type="application/pdf" url="https://example.org/a.pdf"/>'), 'https://example.org'), '');
  for (const url of ['javascript:alert(1)', 'file:///a.png', 'data:image/svg+xml,test', 'https://user:password@example.org/a.png']) assert.equal(safeImageUrl(url), '');
});

test('feed fetching preserves preview images separately from plain-text summaries', async () => {
  const { fetchFeed } = load('rss', { obsidian: { requestUrl: async () => ({ status: 200, text:
    '<rss><channel><item><title>Paper</title><link>https://example.org/paper</link><description><![CDATA[<html><body>Summary<img src="/figure.png"></body></html>]]></description></item></channel></rss>' }) } });
  const [article] = await fetchFeed({ url: 'https://example.org/rss', name: 'Journal' }, 10);
  assert.equal(article.imageUrl, 'https://example.org/figure.png');
  assert.equal(article.summary, 'Summary');
  assert.equal(article.status, 'unread');
  assert.ok(Number.isFinite(Date.parse(article.updatedAt)));
});

test('four sorts have deterministic order without changing stored order', () => {
  const a = { ...paper('a', 'unread', 'Zebra'), source: 'Alpha', updatedAt: '2026-09-09' };
  const b = { ...paper('b', 'unread', 'Alpha'), source: 'Beta', updatedAt: '2026-09-08' };
  assert.deepEqual(sortArticles([a, b], 'title').map(x => x.id), ['b', 'a']);
  assert.deepEqual(sortArticles([a, b], 'journal').map(x => x.id), ['a', 'b']);
  assert.deepEqual(sortArticles([a, b], 'updated').map(x => x.id), ['a', 'b']);
  const c = paper('c'); const d = paper('d');
  const scores = { a: { tier: 'low', score: 20 }, b: { tier: 'high', score: 85 }, c: { tier: 'pending', score: 50 } };
  const original = [a, b, c, d];
  assert.deepEqual(sortArticles(original, 'relevance', scores).map(x => x.id), ['b', 'c', 'd', 'a']);
  for (const key of ['title', 'journal', 'updated', 'relevance']) {
    assert.deepEqual(sortArticles(original, key, scores, true).map(x => x.id), sortArticles(original, key, scores).map(x => x.id).reverse());
  }
  assert.deepEqual(original.map(x => x.id), ['a', 'b', 'c', 'd']);
});

test('recommendation requires both classes and learns local positive/negative terms', async () => {
  await assert.rejects(buildRecommendations([paper('x', 'interested')]), /至少/);
  const items = [paper('p1', 'interested', 'quantum superconductivity'), paper('p2', 'archived', 'quantum superconductivity'),
    paper('n1', 'hidden', 'marine ecology'), paper('n2', 'expired', 'marine ecology'),
    paper('u1', 'unread', 'quantum superconductivity'), paper('u2', 'unread', 'marine ecology'), paper('unknown', 'unread', 'unrelated')];
  let yields = 0;
  const result = await buildRecommendations(items, async () => { yields++; });
  assert.equal(result.positive, 2); assert.equal(result.negative, 2);
  assert.equal(result.scores.u1.tier, 'high'); assert.equal(result.scores.u2.tier, 'low');
  assert.equal(result.scores.unknown, undefined);
  assert.ok(result.scores.u1.terms.some(term => term.includes('quantum')));
  assert.ok(yields > 2);
  assert.equal(result.fingerprint, recommendationFingerprint([...items].reverse()));
  setArticleStatus(items[4], 'hidden');
  assert.notEqual(result.fingerprint, recommendationFingerprint(items));
});

test('reader renders five categories, image column, sorting and empty-basket undo', () => {
  const { document, HTMLElement } = require('linkedom').parseHTML('<html><body><div id="root"></div></body></html>');
  const proto = HTMLElement.prototype;
  Object.defineProperty(Object.getPrototypeOf(document.createElement('select')), 'value', { configurable: true,
    get() { return this.querySelector('option[selected]')?.getAttribute('value') ?? ''; },
    set(value) { this.querySelectorAll('option').forEach(option => option.toggleAttribute('selected', option.getAttribute('value') === value)); } });
  proto.createEl = function(tag, options = {}) {
    const element = document.createElement(tag);
    if (options.text) element.textContent = options.text;
    if (options.cls) element.className = options.cls;
    for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, value);
    for (const key of ['type', 'placeholder', 'value']) if (options[key]) element.setAttribute(key, options[key]);
    this.appendChild(element); return element;
  };
  proto.createDiv = function(options) { return this.createEl('div', options); };
  proto.createSpan = function(options) { return this.createEl('span', options); };
  proto.empty = function() { this.replaceChildren(); };
  proto.addClass = function(name) { this.classList.add(name); };
  proto.createTHead = function() { return this.createEl('thead'); };
  proto.createTBody = function() { return this.createEl('tbody'); };
  proto.insertRow = function() { return this.createEl('tr'); };
  proto.insertCell = function() { return this.createEl('td'); };
  let openedModal;
  class Setting {
    constructor(parent) { this.parent = parent; }
    setName() { return this; } setDesc() { return this; }
    addText(callback) { const input = this.parent.createEl('input'); callback({ inputEl: input, setValue() { return this; }, getValue: () => input.value }); return this; }
    addTextArea(callback) { callback({ setValue() { return this; }, onChange() { return this; } }); return this; }
  }
  class Modal {
    constructor() { this.modalEl = document.createElement('div'); this.contentEl = this.modalEl.createDiv(); }
    open() { openedModal = this; this.onOpen(); }
  }
  const { AiRssView } = load('view', { obsidian: { ItemView: class {}, Modal, Setting, Notice: class {}, getIcon: icon => icon !== 'arrow-down-a-z', setIcon(element, icon) { element.dataset.icon = icon; }, setTooltip() {} } }, document);
  const articles = [...[paper('b', 'unread', 'Beta'), { ...paper('a', 'unread', 'Alpha'), imageUrl: 'https://example.org/figure.png' }].map(article => ({ ...article, curated: true })), paper('explore-only')];
  let curatedRefreshes = 0; let exploreRefreshes = 0;
  const plugin = {
    state: { articles, settings: { profiles: [] } },
    recommendationOptions: { disabledKeywords: [], lowThreshold: null, highThreshold: null, userInterest: '' },
    canUndoStatus: true,
    saveState: async () => {},
    refreshCuratedFeeds: async () => { curatedRefreshes++; },
    refreshExploreFeeds: async () => { exploreRefreshes++; },
  };
  const view = new AiRssView({}, plugin);
  view.contentEl = document.getElementById('root');
  view.render();
  const root = view.contentEl;
  assert.equal(root.querySelectorAll('.ai-rss-metric').length, 5);
  assert.ok(root.querySelector('th:last-child').textContent.includes('预览图'));
  assert.equal(root.querySelectorAll('tbody tr').length, 2);
  assert.equal(root.querySelectorAll('[role="tab"]').length, 2);
  assert.equal(root.querySelector('.ai-rss-recommendations'), null);
  [...root.querySelectorAll('button')].find(button => button.textContent.includes('更新订阅')).click();
  assert.equal(curatedRefreshes, 1); assert.equal(exploreRefreshes, 0);
  assert.match(root.querySelector('.ai-rss-preview-button').title, /放大查看/);
  root.querySelector('.ai-rss-preview-button').click();
  assert.equal(openedModal.contentEl.querySelector('h3').textContent, '摘要图');
  assert.equal(openedModal.contentEl.querySelector('img').src, 'https://example.org/figure.png');
  assert.equal(root.querySelector('img').getAttribute('loading'), 'lazy');
  const titleSort = [...root.querySelectorAll('button')].find(button => button.textContent === '按标题');
  titleSort.click();
  assert.equal(root.querySelector('tbody tr').dataset.articleId, 'a');
  const clickSort = key => root.querySelector(`[data-sort="${key}"]`).click();
  clickSort('title');
  assert.equal(root.querySelector('tbody tr').dataset.articleId, 'b');
  assert.match(root.querySelector('[data-sort="title"]').textContent, /↓/);
  clickSort('title');
  assert.equal(root.querySelector('tbody tr').dataset.articleId, 'a');
  articles[0].updatedAt = '2026-09-10'; articles[1].updatedAt = '2026-09-08';
  articles[0].source = 'Beta'; articles[1].source = 'Alpha';
  view.scores = { a: { tier: 'high', score: 90, terms: [] }, b: { tier: 'low', score: 10, terms: [] } };
  for (const [key, first, second] of [['updated', 'b', 'a'], ['journal', 'a', 'b'], ['relevance', 'a', 'b']]) {
    clickSort(key);
    assert.equal(root.querySelector('tbody tr').dataset.articleId, first);
    clickSort(key);
    assert.equal(root.querySelector('tbody tr').dataset.articleId, second);
    assert.equal(root.querySelector(`[data-sort="${key}"]`).getAttribute('aria-pressed'), 'true');
  }
  assert.equal(plugin.state.articleSort, undefined, 'curated sorting does not change exploration sorting');
  clickSort('title');
  assert.equal(root.querySelector('tbody tr').dataset.articleId, 'a', 'switching resets to default order');
  clickSort('title');
  const reopened = new AiRssView({}, { ...plugin, state: JSON.parse(JSON.stringify(plugin.state)) });
  reopened.contentEl = document.createElement('div');
  reopened.render();
  assert.equal(reopened.contentEl.querySelector('tbody tr').dataset.articleId, 'b', 'saved descending order survives reopening');
  root.querySelector('[data-metric="hidden"]').click();
  assert.equal(root.querySelectorAll('tbody tr').length, 0);
  const undo = [...root.querySelectorAll('button')].find(button => button.textContent === '撤回分类');
  assert.equal(undo.disabled, false);
  assert.equal(root.querySelector('[data-metric="hidden"]').getAttribute('aria-pressed'), 'true');
  [...root.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === '探索模式').click();
  [...root.querySelectorAll('button')].find(button => button.textContent.includes('更新订阅')).click();
  assert.equal(curatedRefreshes, 1); assert.equal(exploreRefreshes, 1);
  assert.equal(root.querySelectorAll('.ai-rss-explore-card').length, 1);
  assert.equal(root.querySelector('.ai-rss-explore-card h3').textContent, 'explore-only');
  assert.ok(root.querySelector('.ai-rss-recommendations'));
  for (const [label, icon] of [['刷新', 'refresh-cw'], ['撤回分类', 'undo-2'], ['翻译标题', 'languages'], ['按标题', 'arrow-down-az'], ['按期刊', 'book-open'], ['按相关度', 'sparkles'], ['使用 LLM 复核待判断文章', 'bot']]) {
    const button = [...root.querySelectorAll('button')].find(button => button.textContent === label);
    assert.equal(button.querySelector('.ai-rss-f-action-icon').dataset.icon, icon);
    assert.equal(button.querySelector('.ai-rss-f-action-icon').getAttribute('aria-hidden'), 'true');
  }
  assert.equal(root.querySelector('table'), null);
});
