const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const code = buildSync({ entryPoints: ['src/literature.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;

test('accepts complete DOI metadata and rejects publisher-specific short identifiers', () => {
  const sandbox = { module: { exports: {} }, exports: {},
    require: name => name === 'obsidian' ? { TFile: class {}, normalizePath: p => p } : require(name) };
  vm.runInNewContext(code, sandbox);
  const { normalizeDoi } = sandbox.module.exports;
  assert.equal(normalizeDoi('https://doi.org/10.1126/science.abq8684'), '10.1126/science.abq8684');
  assert.equal(normalizeDoi('doi: 10.1038/nature12373'), '10.1038/nature12373');
  assert.equal(normalizeDoi('abq8684'), '');
});

for (const [source, folder] of [['Nature', 'Nature'], ['物理 / PRX: News', '物理 - PRX- News'], ['', '未命名 RSS'], ['..', '未命名 RSS'], ['CON', '_CON'], ['a'.repeat(100), 'a'.repeat(80)]]) {
  test(`saves literature beneath a safe RSS folder: ${source}`, async () => {
    const writes = [], folders = [];
    const sandbox = { module: { exports: {} }, exports: {}, URL,
      document: { implementation: { createHTMLDocument: () => ({}) } },
      require: name => name === 'obsidian' ? { TFile: class {}, normalizePath: p => p } : require(name) };
    vm.runInNewContext(code, sandbox);
    const app = { vault: {
      getAbstractFileByPath: () => null,
      createFolder: async path => folders.push(path),
      create: async path => writes.push(path),
    } };
    const article = { title: 'Example paper', source, link: 'https://example.org/paper', summary: '', published: '2026-01-01', analysis: {}, matchedProfiles: [] };
    for (const outputFolder of ['', 'Custom/Papers']) {
      const result = await sandbox.module.exports.saveLiteraturePackage(app, article, {
        outputFolder, literatureFolderTemplate: '{author} - {year} - {title}',
        noteNameFormat: '{{citekey}}', noteContentFormat: '{{title}}', noteProperties: [],
      });
      const prefix = `${outputFolder || 'AI RSS Reader'}/${folder}/`;
      assert.ok(result.markdownPath.startsWith(prefix));
      assert.match(result.markdownPath.slice(prefix.length), /^[^/]+ - 2026 - Example paper\/[^/]+\.md$/);
      assert.ok(writes.includes(result.markdownPath));
      assert.ok(folders.includes(prefix.slice(0, -1)));
    }
  });
}
