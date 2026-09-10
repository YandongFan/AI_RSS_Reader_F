const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

function loadCheckAllFeeds(fetchFeed) {
  const code = transformSync(readFileSync('src/feed-health.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
  const sandbox = {
    module: { exports: {} }, exports: {},
    require: name => name === './rss' ? { fetchFeed } : require(name),
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports.checkAllFeeds;
}

test('checks every configured feed, including disabled feeds, and preserves order', async () => {
  const calls = [];
  const checkAllFeeds = loadCheckAllFeeds(async feed => {
    calls.push(feed.id);
    if (feed.id === 'bad') throw new Error('HTTP 503');
    return feed.id === 'empty' ? [] : [{ id: 'article' }];
  });
  const feeds = [
    { id: 'good', name: 'Good', url: 'https://example.com/good', enabled: true },
    { id: 'bad', name: 'Bad', url: 'https://example.com/bad', enabled: false },
    { id: 'empty', name: 'Empty', url: 'https://example.com/empty', enabled: true },
  ];

  const results = await checkAllFeeds(feeds);

  assert.deepEqual(calls.sort(), ['bad', 'empty', 'good']);
  assert.deepEqual(Array.from(results, result => result.feed.id), ['good', 'bad', 'empty']);
  assert.deepEqual(Array.from(results, result => [result.ok, result.hasEntries, result.error]), [
    [true, true, undefined],
    [false, false, 'HTTP 503'],
    [true, false, undefined],
  ]);
});

test('normalizes non-Error probe failures for display', async () => {
  const checkAllFeeds = loadCheckAllFeeds(async () => { throw '连接被拒绝'; });
  const [result] = await checkAllFeeds([{ id: 'feed', name: 'Feed', url: 'https://example.com', enabled: true }]);
  assert.equal(result.ok, false);
  assert.equal(result.error, '连接被拒绝');
});
