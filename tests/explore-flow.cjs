const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { buildSync, transformSync } = require('esbuild');
function load(name) {
  const mod = { exports: {} };
  const code = buildSync({ entryPoints: [`src/${name}.ts`], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}
const feedFile = load('feed-file');
const state = load('article-state');
const rec = load('recommendation');
const paper = (id, status, title = id) => ({ id, status, title, read: status !== 'unread', link: `https://example.org/${id}`, summary: '', source: '', matchedProfiles: [], fetchedAt: new Date().toISOString() });
const samples = () => [paper('p1', 'interested', 'quantum superconductivity'), paper('p2', 'archived', 'quantum superconductivity'), paper('n1', 'hidden', 'marine ecology'), paper('n2', 'expired', 'marine ecology'), paper('u1', 'unread', 'quantum superconductivity')];

test('RSS export includes disabled and failed sources; import deduplicates and preserves IDs', () => {
  const feeds = [{ id: 'a', name: '中文期刊', url: 'https://example.org/rss', enabled: true }, { id: 'b', name: 'Failed', url: 'https://example.org/other', enabled: false }];
  const content = feedFile.serializeFeedSources(feeds, feeds.map(feed => ({ feed, ok: feed.id === 'a' })));
  assert.equal(JSON.parse(content).feeds[1].health, 'failed');
  let id = 0;
  const imported = feedFile.importFeedSources(content, [], () => String(++id));
  assert.equal(imported.length, 2); assert.equal(imported[1].enabled, false);
  assert.equal(imported[0].name, '中文期刊');
  assert.deepEqual(feedFile.importFeedSources(content, imported, () => { throw Error('duplicate'); }), imported);
  assert.equal(feedFile.importFeedSources(JSON.stringify([{ url: feeds[0].url + '#fragment' }]), imported, () => 'x').length, 2);
});
test('invalid RSS import is atomic and rejects non-web URLs and embedded credentials', () => {
  const existing = [{ id: 'a', name: 'Original', url: 'https://example.org/rss', enabled: true }];
  for (const url of ['javascript:alert(1)', 'file:///x', 'https://user:secret@example.org/rss', 'bad']) {
    assert.throws(() => feedFile.importFeedSources(JSON.stringify([{ url: existing[0].url, name: 'Changed' }, { url }]), existing, () => 'new'));
    assert.equal(existing[0].name, 'Original');
  }
});
test('curated articles are virtual positives without changing the saved basket', () => {
  const items = [{ ...paper('legacy', 'unread'), matchedProfiles: ['profile'] }, { ...paper('explicit', 'hidden'), curated: true }, { ...paper('explore', 'unread'), curated: false, matchedProfiles: ['old'] }];
  assert.deepEqual(items.map(state.isCurated), [true, true, false]);
  assert.deepEqual(state.recommendationArticles(items).map(state.articleStatus), ['interested', 'interested', 'unread']);
  assert.equal(items[0].status, 'unread'); assert.equal(items[1].status, 'hidden');
});
test('recommendation supports thresholds, keyword toggles, unchanged-model reuse and cancellation', async () => {
  const items = samples();
  const options = { disabledKeywords: [], lowThreshold: 20, highThreshold: 80, userInterest: '' };
  const first = await rec.buildRecommendations(items, async () => {}, options);
  assert.equal(first.lowThreshold, 20); assert.equal(first.highThreshold, 80);
  const second = await rec.buildRecommendations([...items, paper('new', 'unread', 'marine ecology')], async () => {}, options, first);
  assert.equal(second.trainingFingerprint, first.trainingFingerprint);
  assert.deepEqual(second.keywords, first.keywords); assert.ok(second.scores.new);
  const disabled = { ...options, disabledKeywords: ['quantum'] };
  const third = await rec.buildRecommendations(items, async () => {}, disabled, first);
  assert.ok(!third.scores.u1.terms.some(term => term.slice(1) === 'quantum'));
  assert.ok(third.keywords.some(term => term.term === 'quantum'));
  assert.notEqual(first.fingerprint, third.fingerprint);
  await assert.rejects(rec.buildRecommendations(items, async () => { throw Error('cancelled'); }), /cancelled/);
  await assert.rejects(rec.buildRecommendations(items, async () => {}, { ...options, lowThreshold: 90 }), /阈值/);
});

function pluginHarness(extra = {}) {
  const notices = [];
  const imports = {
    obsidian: { Plugin: class {}, Notice: class { constructor(value) { notices.push(value); } }, normalizePath: value => value },
    './article-state': state, './recommendation': rec, './feed-file': feedFile,
    './ezproxy': { EzProxyLogin: class {} },
    ...extra,
  };
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', transformSync(readFileSync('src/main.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code)(mod, mod.exports, name => imports[name] ?? {});
  const plugin = new mod.exports.default();
  plugin.state = { articles: [], seenLinks: [], settings: { feeds: [{ id: 'f', enabled: true }], profiles: [], keywordFilter: false } };
  plugin.getView = () => undefined; plugin.saveState = async () => {};
  return { plugin, notices };
}
test('RSS articles survive AI failure and previously discarded links enter exploration', async () => {
  const fresh = paper('new', 'unread');
  const { plugin } = pluginHarness({ './rss': { fetchAllFeeds: async () => [fresh] }, './ai': { analyzeArticles: async () => { throw Error('offline'); } } });
  plugin.state.seenLinks = [fresh.link];
  await plugin.refreshFeeds();
  assert.equal(plugin.state.articles.length, 1);
  assert.equal(state.isCurated(plugin.state.articles[0]), false);
});
test('health check exports after failed probes and import reads that same plugin-root file', async () => {
  const { plugin } = pluginHarness({ './feed-health': { checkAllFeeds: async feeds => feeds.map(feed => ({ feed, ok: false })) } });
  plugin.state.settings.feeds = [{ id: 'a', name: 'A', url: 'https://example.org/rss', enabled: false }];
  plugin.manifest = { dir: '.obsidian/plugins/ai-rss-reader-f' };
  const files = new Map();
  plugin.app = { vault: { adapter: { write: async (path, contents) => files.set(path, contents), read: async path => files.get(path) } } };
  await plugin.checkAndExportFeeds();
  assert.ok(files.has('.obsidian/plugins/ai-rss-reader-f/rss-sources.json'));
  await plugin.importLocalFeeds();
  assert.equal(plugin.state.settings.feeds.length, 1);
  assert.equal(plugin.state.settings.feeds[0].id, 'a');
});
test('LLM review sends only pending exploration papers and ignores late results after state changes', async () => {
  const calls = [];
  const { plugin } = pluginHarness({ './ai': { generateText: async (_, prompt) => { calls.push(prompt); return 'high'; } } });
  plugin.state.articles = [...samples(), { ...paper('curated', 'unread'), curated: true }];
  plugin.state.recommendations = { fingerprint: rec.recommendationFingerprint(state.recommendationArticles(plugin.state.articles), plugin.recommendationOptions), scores: { u1: { tier: 'pending', score: 50 }, curated: { tier: 'pending', score: 50 } } };
  await plugin.reviewPendingRecommendations();
  assert.equal(calls.length, 1); assert.equal(plugin.state.recommendations.scores.u1.tier, 'high');
  plugin.state.recommendations.scores.u1.tier = 'pending';
  plugin.state.articles[0].status = 'hidden';
  await plugin.reviewPendingRecommendations();
  assert.equal(calls.length, 1);
});
