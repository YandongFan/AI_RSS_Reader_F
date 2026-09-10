const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/audio-tutor-source.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'],
}).outputFiles[0].text;

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    const dot = this.name.lastIndexOf('.');
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name;
    this.extension = dot > 0 ? this.name.slice(dot + 1) : '';
    const parentPath = path.split('/').slice(0, -1).join('/');
    this.parent = { path: parentPath, parent: { path: parentPath.split('/').slice(0, -1).join('/') } };
  }
}
const sandbox = {
  module: { exports: {} }, exports: {}, URL,
  require: name => name === 'obsidian'
    ? { App: class {}, TFile, normalizePath: value => String(value).replace(/\\/g, '/').replace(/\/{2,}/g, '/') }
    : require(name),
};
vm.runInNewContext(code, sandbox);
const api = sandbox.module.exports;

test('derives the complete MinerU bundle paths from a PDF', () => {
  const paths = api.expectedMinerUPaths({ parent: { path: 'Papers' }, basename: 'Weyl response' });
  assert.equal(paths.markdown, 'Papers/Miner_U/Weyl response_MinerU.md');
  assert.equal(paths.contentList, 'Papers/Miner_U/Weyl response_MinerU_content_list.json');
  assert.equal(paths.layout, 'Papers/Miner_U/Weyl response_MinerU_layout.json');
});

test('finds only numbered supplementary PDFs beside the main paper in numeric order', () => {
  const main = new TFile('Papers/Smith2025.pdf');
  const files = [
    main,
    new TFile('Papers/Smith2025-supplementary-10.pdf'),
    new TFile('Papers/Smith2025-supplementary-2.pdf'),
    new TFile('Papers/Smith2025-peer-review-1.pdf'),
    new TFile('Other/Smith2025-supplementary-1.pdf'),
    new TFile('Papers/Smith2025-supplementary-notes.pdf'),
  ];
  const found = api.findSupplementaryPdfs({ vault: { getFiles: () => files } }, main);
  assert.deepEqual(Array.from(found, file => file.path), [
    'Papers/Smith2025-supplementary-2.pdf',
    'Papers/Smith2025-supplementary-10.pdf',
  ]);
});

test('finds local Markdown image dependencies and ignores remote images', () => {
  const markdown = '![](Figures/a.jpg)\n![b](<Figures/b.jpg>)\n<img src="Figures/c.png">\n![](https://example.com/remote.png)';
  assert.deepEqual(Array.from(api.extractMarkdownImagePaths(markdown)), ['Figures/a.jpg', 'Figures/b.jpg', 'Figures/c.png']);
});

test('extracts display formulas with stable fallback ids and context', () => {
  const formulas = api.extractFormulaEntries('# Model\nBefore.\n$$E_\\pm=d_0\\pm|d|\\tag{3}$$\nAfter.\n\n\\[\\Omega_n(k)\\]');
  assert.equal(formulas.length, 2);
  assert.equal(formulas[0].id, 'Eq. 3');
  assert.equal(formulas[1].id, '公式 2');
  assert.match(formulas[0].context, /Before/);
});

test('requires Markdown, content-list, layout, and every referenced local image', async () => {
  const files = new Map();
  const add = path => { const file = new TFile(path); files.set(path, file); return file; };
  const pdf = add('Papers/Paper.pdf');
  add('Papers/Miner_U/Paper_MinerU.md');
  add('Papers/Miner_U/Paper_MinerU_content_list.json');
  add('Papers/Miner_U/Paper_MinerU_layout.json');
  const content = new Map([
    ['Papers/Miner_U/Paper_MinerU.md', '# Paper\n![](Figures/missing.jpg)'],
    ['Papers/Miner_U/Paper_MinerU_content_list.json', '[]'],
    ['Papers/Miner_U/Paper_MinerU_layout.json', '{}'],
  ]);
  const app = { vault: {
    getAbstractFileByPath: path => files.get(path),
    getFiles: () => [...files.values()],
    cachedRead: file => Promise.resolve(content.get(file.path) ?? ''),
  } };
  const missing = await api.inspectMinerUSource(app, pdf);
  assert.deepEqual(Array.from(missing.missing), ['图片 Figures/missing.jpg']);
  add('Papers/Miner_U/Figures/missing.jpg');
  const complete = await api.inspectMinerUSource(app, pdf);
  assert.deepEqual(Array.from(complete.missing), []);
});
