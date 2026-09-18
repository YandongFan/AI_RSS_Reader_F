const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

const code = buildSync({ entryPoints: ['src/profile-reanalysis.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const mod = { exports: {} };
new Function('module', 'exports', code)(mod, mod.exports);
const { researchProfileFingerprint, recentRssArticles, mergeAnalysisCandidates } = mod.exports;
const profile = (id, description, enabled = true) => ({ id, name: id.toUpperCase(), description, enabled });
const article = (id, fetchedAt, source = 'Journal') => ({ id, link: `https://example.org/${id}`, fetchedAt, source });

test('profile fingerprint changes only when enabled analysis directions change', () => {
  const base = [profile('a', 'alpha'), profile('b', 'beta')];
  assert.equal(researchProfileFingerprint(base), researchProfileFingerprint([...base].reverse()));
  assert.notEqual(researchProfileFingerprint(base), researchProfileFingerprint([profile('a', 'changed'), base[1]]));
  assert.notEqual(researchProfileFingerprint(base), researchProfileFingerprint([base[0], { ...base[1], enabled: false }]));
  assert.equal(researchProfileFingerprint(base), researchProfileFingerprint([...base, profile('disabled', 'ignored', false)]));
});

test('recent RSS selection uses fetched time, includes the one-day boundary, and excludes manual imports', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  const values = [
    article('new', '2026-09-15T11:00:00Z'),
    article('boundary', '2026-09-14T12:00:00Z'),
    article('old', '2026-09-14T11:59:59Z'),
    article('manual', '2026-09-15T11:00:00Z', '手动导入'),
    article('invalid', 'not-a-date'),
  ];
  assert.deepEqual(recentRssArticles(values, 1, now).map(item => item.id), ['new', 'boundary']);
  assert.deepEqual(recentRssArticles(values, 0, now), []);
});

test('candidate merge preserves priority order and removes duplicate links', () => {
  const first = article('first', '2026-09-15T00:00:00Z');
  const duplicate = { ...first, id: 'duplicate' };
  const second = article('second', '2026-09-15T00:00:00Z');
  assert.deepEqual(mergeAnalysisCandidates([first], [duplicate, second]).map(item => item.id), ['first', 'second']);
});
