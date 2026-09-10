const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { parseLinkedomHTML } = require('../node_modules/defuddle/dist/utils/linkedom-compat.js');
// linkedom does not wrap fragments in html/body as the browser DOMParser does.
class DOMParser {
  parseFromString(html) {
    return parseLinkedomHTML(/<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`);
  }
}
const code = buildSync({ entryPoints: ['src/cleaning.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['defuddle', 'defuddle/full'] }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, exports: {}, URL, DOMParser, require: id => id === 'defuddle/full' ? require('../node_modules/defuddle/dist/markdown.js') : require(id) };
vm.runInNewContext(code, sandbox);
const { convertArticle, cleanArticle, ensureRuleFiles, loadRules, parseRule, ruleFilename, defaultRule } = sandbox.module.exports;
const canonical = 'https://www.nature.com/articles/example';
const proxy = 'https://www-nature-com.sutd.idm.oclc.org/articles/example';
const prose = 'Stable ferroelectricity in ultrathin films is important for scientific research and semiconductor devices. '.repeat(12);
const html = `<html><head><title>Scientific article</title></head><body><article><h2>Abstract</h2><p>${prose}<span class="unwrap">KEEP</span><span class="noise">NOISE</span></p><h2>Methods</h2><p>${prose}Ga<sub>2</sub>O<sub>3</sub><sup id="fnref:1"><a href="#fn:1">1</a></sup></p><figure><img src="https://media.example.com/image.png" width="800" height="600" alt="Experiment"><figcaption>Experimental figure caption</figcaption></figure><p><a href="${proxy}#Fig1">Figure</a> <a href="https://doi-org.sutd.idm.oclc.org/10.1000/test">DOI</a></p><table><tr><th>Sample</th><th>Voltage</th></tr><tr><td>A</td><td>0.8</td></tr></table><h2>Extended data</h2><p>${prose}</p><ol class="footnotes"><li id="fn:1"><p>Reference author, journal, 2026.<a class="footnote-backref" href="#fnref:1">↩</a></p></li></ol></article></body></html>`;
const document = () => new DOMParser().parseFromString(html);
function adapter() {
  const files = new Map();
  return { files, exists: async p => files.has(p), mkdir: async p => { files.set(p, null); }, read: async p => files.get(p), write: async (p, t) => { files.set(p, t); } };
}
test('real Defuddle + Markdown converter preserve scientific structure and rewrite known proxy hosts', () => {
  const doc = document();
  const result = convertArticle(doc, proxy, canonical, [defaultRule('Nature')]);
  assert.match(result, /## Abstract/);
  assert.match(result, /## Methods/);
  assert.match(result, /## Extended data/);
  assert.match(result, /!\[Experiment\]\(https:\/\/media.example.com\/image.png\)/);
  assert.match(result, /\[\^1\]:.*Reference author/);
  assert.match(result, /<sub>2<\/sub>/);
  assert.match(result, /\| Sample \| Voltage \|/);
  assert.match(result, /https:\/\/doi.org\/10.1000\/test/);
  assert.doesNotMatch(result, /sutd.idm.oclc.org|<main>|<p>|footnote-backref/);
  assert.match(doc.body.innerHTML, /NOISE/);
});
test('common then exact source rules apply selectors, preserve overrides, and ordered replacements', () => {
  const rules = [
    { version: 1, name: '_common', removeSelectors: ['.noise'], preserve: { images: false }, replacements: [{ find: 'KEEP', replace: 'FIRST' }] },
    { version: 1, name: 'Nature', contentSelector: 'article', unwrapSelectors: ['.unwrap'], preserve: { images: true, tables: false }, replacements: [{ find: 'FIRST', replace: 'FINAL', regex: true, flags: 'g' }] },
  ];
  const result = convertArticle(document(), proxy, canonical, rules);
  assert.match(result, /FINAL/);
  assert.match(result, /!\[Experiment\]/);
  assert.doesNotMatch(result, /NOISE|KEEP|FIRST|\| Sample/);
});
test('optional images, captions and footnotes can be removed', () => {
  const result = convertArticle(document(), proxy, canonical, [{ version: 1, name: 'Nature', preserve: { images: false, captions: false, footnotes: false } }]);
  assert.doesNotMatch(result, /!\[|Experimental figure caption|\[\^1\]/);
  assert.match(result, /## Methods/);
});
test('initialization preserves user JSON; hot reload and exact names do not leak Nature rules', async () => {
  const a = adapter();
  await Promise.all([ensureRuleFiles(a, ['Nature', 'Nature Electronics']), ensureRuleFiles(a, ['Nature'])]);
  const path = 'AI RSS Reader/rules/Nature.json';
  const custom = JSON.stringify({ version: 1, name: 'Nature', enabled: false });
  a.files.set(path, custom);
  await ensureRuleFiles(a, ['Nature']);
  assert.equal(a.files.get(path), custom);
  assert.equal((await loadRules(a, 'Nature')).length, 1);
  assert.equal((await loadRules(a, 'Nature Electronics'))[1].name, 'Nature Electronics');
  a.files.set(path, JSON.stringify(defaultRule('Nature')));
  assert.equal((await loadRules(a, 'Nature')).length, 2);
});
test('invalid JSON, CSS, missing body match and empty output fall back to default conversion with warnings', async () => {
  for (const invalid of ['{', JSON.stringify({ version: 1, name: 'Nature', removeSelectors: ['['] }), JSON.stringify({ version: 1, name: 'Nature', contentSelector: '.missing' }), JSON.stringify({ version: 1, name: 'Nature', replacements: [{ find: '[\\s\\S]+', replace: '', regex: true }] })]) {
    const a = adapter();
    await ensureRuleFiles(a, ['Nature']);
    a.files.set('AI RSS Reader/rules/Nature.json', invalid);
    const warnings = [];
    const result = await cleanArticle(a, 'Nature', document(), proxy, canonical, warnings);
    assert.equal(warnings.length, 1);
    assert.match(result, /## Abstract/);
    assert.match(result, /\[\^1\]:/);
    assert.doesNotMatch(result, /<main>|<p>/);
  }
});
test('validation rejects wrong source, misspelled operations and malformed regex', () => {
  for (const rule of [{ version: 1, name: 'Other' }, { version: 1, name: 'Nature', removeSelector: [] }, { version: 1, name: 'Nature', replacements: [{ find: '[', replace: '', regex: true }] }]) assert.throws(() => parseRule(JSON.stringify(rule), 'Nature'));
  assert.equal(ruleFilename('Nature Electronics'), 'Nature Electronics.json');
  assert.doesNotMatch(ruleFilename('../A/B'), /[/\\]/);
  assert.notEqual(ruleFilename('A/B'), ruleFilename('A%2FB'));
  assert.notEqual(ruleFilename('_common'), '_common.json');
});
