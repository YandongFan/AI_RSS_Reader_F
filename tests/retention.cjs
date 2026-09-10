const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const code = require('esbuild').buildSync({ entryPoints: ['src/retention.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, exports: {}, require };
vm.runInNewContext(code, sandbox);
const { pruneExpiredArticles, setArticleRead } = sandbox.module.exports;
const day = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-05T00:00:00.000Z');
const settings = { readRetentionDays: 30, unreadRetentionDays: 90 };

function article(overrides = {}) {
  return {
    id: 'paper', title: 'Paper', link: 'https://example.com', summary: '', published: '', source: 'RSS',
    fetchedAt: new Date(now).toISOString(), read: false, matchedProfiles: [], analysis: {}, ...overrides,
  };
}

test('expires unread entries while keeping legacy read and saved entries archived', () => {
  const articles = [
    article({ id: 'old-read', read: true, readAt: new Date(now - 30 * day).toISOString(), savedPath: 'kept-on-disk.md' }),
    article({ id: 'new-read', read: true, readAt: new Date(now - 29 * day).toISOString() }),
    article({ id: 'old-unread', fetchedAt: new Date(now - 90 * day).toISOString() }),
    article({ id: 'new-unread', fetchedAt: new Date(now - 89 * day).toISOString() }),
  ];
  const result = pruneExpiredArticles(articles, settings, now);
  assert.deepEqual(Array.from(result.articles, item => item.id), ['old-read', 'new-read', 'old-unread', 'new-unread']);
  assert.equal(result.removed, 0);
  assert.equal(result.articles[0].status, 'archived');
  assert.equal(result.articles[2].status, 'expired');
});

test('zero disables expiry and legacy read entries migrate to archive', () => {
  const old = article({ read: true, fetchedAt: new Date(now - 365 * day).toISOString() });
  const result = pruneExpiredArticles([old], { readRetentionDays: 0, unreadRetentionDays: 0 }, now);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].status, 'archived');
  assert.equal(result.changed, true);
});

test('marking unread resets the read timestamp and marking read starts a new clock', () => {
  const value = article();
  setArticleRead(value, true, now);
  assert.equal(value.read, true);
  assert.equal(value.readAt, new Date(now).toISOString());
  setArticleRead(value, false, now + day);
  assert.equal(value.read, false);
  assert.equal(value.readAt, undefined);
});
