const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

class MockTFile {
  constructor(path) { this.path = path; this.extension = path.split('.').pop(); this.name = path.split('/').pop(); }
}

// Exercise the real save entry point while keeping all vault writes mocked.
const code = transformSync(readFileSync('src/main.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const inputModule = { exports: {} };
vm.runInNewContext(transformSync(readFileSync('src/literature-input.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: inputModule, exports: {}, URL });
const retentionModule = { exports: {} };
vm.runInNewContext(require('esbuild').buildSync({ entryPoints: ['src/retention.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text,
  { module: retentionModule, exports: {}, require });
function setup(ezProxyEnabled) {
  const captureDeferreds = [];
  const calls = { capture: [], save: [], state: 0, opened: [], created: [], folders: [] };
  const settings = { extractFullText: true, openNoteAfterSingleSave: true, batchCaptureIntervalSeconds: 1.5, ezProxyEnabled, ezProxyPrefix: 'https://sutd.idm.oclc.org' };
  const articleStateModule = { exports: {} };
  vm.runInNewContext(transformSync(readFileSync('src/article-state.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
    { module: articleStateModule, exports: {}, require });
  const imports = {
    './article-state': articleStateModule.exports,
    './literature-input': inputModule.exports,
    './retention': retentionModule.exports,
    './audio-tutor-source': { isAudioTutorInput: file => file instanceof MockTFile && (file.extension === 'pdf' || /_MinerU\.md$/i.test(file.path)) },
    obsidian: {
      Plugin: class {},
      TFile: MockTFile,
      Notice: class { setMessage() {} hide() {} },
    },
    './ezproxy': { EzProxyLogin: class {}, bypassEzProxy: url => new URL(url).hostname === 'arxiv.org' },
    './defaults': { DEFAULT_STATE: { settings }, DEFAULT_SETTINGS: settings },
    './browser-page': { ensureBrowserArticle: (...args) => {
      calls.capture.push(args);
      return new Promise((resolve, reject) => captureDeferreds.push({ resolve, reject }));
    } },
    './literature': { saveLiteraturePackage: async (...args) => {
      calls.save.push(args);
      return { markdownPath: 'saved.md', warnings: [] };
    } },
  };
  const sandbox = { module: { exports: {} }, exports: {}, structuredClone, AbortController, setTimeout, require: id => imports[id] || {} };
  vm.runInNewContext(code, sandbox);
  const plugin = new sandbox.module.exports.default();
  const savedFile = { path: 'saved.md' };
  const vaultFiles = new Map([[savedFile.path, savedFile]]);
  plugin.app = {
    vault: {
      getFileByPath: path => vaultFiles.get(path) ?? null,
      getAbstractFileByPath: path => vaultFiles.get(path) ?? (calls.folders.includes(path) ? { path } : null),
      createFolder: async path => { calls.folders.push(path); },
      create: async (path, content) => {
        const file = { path, content };
        vaultFiles.set(path, file);
        calls.created.push(file);
        return file;
      },
      process: async (file, update) => { file.content = update(file.content); },
    },
    workspace: { getLeaf: () => ({ openFile: async file => { calls.opened.push(file); } }) },
  };
  plugin.saveState = async () => { calls.state++; };
  return {
    plugin, calls, captureDeferreds,
    resolveCapture: value => captureDeferreds[0].resolve(value),
    rejectCapture: error => captureDeferreds[0].reject(error),
  };
}

function createMenuHarness() {
  const menu = {
    items: [],
    separators: 0,
    addSeparator() { this.separators++; },
    addItem(configure) {
      const entry = { title: '', icon: '', click: null, submenu: null };
      const item = {
        setTitle(title) { entry.title = title; return this; },
        setIcon(icon) { entry.icon = icon; return this; },
        onClick(click) { entry.click = click; return this; },
        setSubmenu() { entry.submenu = createMenuHarness(); return entry.submenu; },
      };
      configure(item);
      this.items.push(entry);
      return this;
    },
  };
  return menu;
}

test('Audio Tutor file actions are grouped in one expandable submenu', () => {
  const { plugin } = setup(false);
  const menu = createMenuHarness();

  plugin.addAudioTutorFileMenu(menu, new MockTFile('Papers/theory.pdf'));

  assert.equal(menu.separators, 1);
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Audio Tutor');
  assert.equal(menu.items[0].icon, 'graduation-cap');
  assert.deepEqual(menu.items[0].submenu.items.map(item => item.title), [
    '生成全部学习材料',
    '生成粗读讲稿',
    '生成公式详解',
    '打开推导练习',
    '生成理解检查',
    '生成复习笔记',
  ]);
});

test('every Markdown file gets playback and MP3 actions in the Audio Tutor submenu', () => {
  const { plugin } = setup(false);
  const menu = createMenuHarness();

  plugin.addAudioTutorFileMenu(menu, new MockTFile('Notes/general.md'));

  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].title, 'Audio Tutor');
  assert.deepEqual(menu.items[0].submenu.items.map(item => item.title), [
    '朗读此 Markdown',
    '保存为 MP3',
  ]);
});

for (const openNoteAfterSingleSave of [true, false]) {
  test(`single save ${openNoteAfterSingleSave ? 'opens' : 'does not open'} the generated note according to settings`, async () => {
    const t = setup(false);
    t.plugin.state.settings.openNoteAfterSingleSave = openNoteAfterSingleSave;
    const article = { link: 'https://example.com/paper', title: 'Paper', read: false };
    const pending = t.plugin.saveArticleAsNote(article);
    t.resolveCapture({ url: article.link, html: '<html>Paper</html>' });
    assert.equal(await pending, 'saved.md');
    assert.equal(t.calls.opened.length, openNoteAfterSingleSave ? 1 : 0);
    if (openNoteAfterSingleSave) assert.equal(t.calls.opened[0].path, 'saved.md');
  });
}

test('manual DOI uses the existing save entry point; invalid input never starts saving', async () => {
  const { plugin } = setup(false);
  plugin.state.articles = [];
  const saved = [];
  plugin.saveArticleAsNote = async article => { saved.push(article); return 'manual.md'; };
  assert.equal(await plugin.openLiteratureLink(' doi: 10.1038/nature12373 '), 'manual.md');
  assert.equal(saved[0].link, 'https://doi.org/10.1038/nature12373');
  assert.equal(saved[0].source, '手动导入');
  for (const invalid of ['', 'not a DOI', 'javascript:alert(1)', 'file:///C:/paper.pdf', 'https://']) {
    await assert.rejects(plugin.openLiteratureLink(invalid), /请输入/);
  }
  assert.equal(saved.length, 1);
});

test('interactive save folders normalize vault-relative paths and reject unsafe paths', () => {
  const normalize = inputModule.exports.normalizeLiteratureSaveFolder;
  assert.equal(normalize(' Papers\\Literature/ '), 'Papers/Literature');
  for (const invalid of ['', '../Outside', 'C:\\Papers', '/absolute', 'Papers/CON', 'Papers/bad:name']) {
    assert.throws(() => normalize(invalid), /Obsidian 库内|请输入/);
  }
});

test('multiple manual links normalize, deduplicate, reuse RSS articles, and enter the shared batch queue', async () => {
  const { plugin } = setup(false);
  const existing = { id: 'rss', link: 'https://doi.org/10.1038/nature12373', title: 'Existing RSS article' };
  plugin.state.articles = [existing];
  const queued = [];
  plugin.saveArticlesAsNotes = async articles => {
    queued.push(...articles);
    return { saved: articles, failures: [] };
  };

  const result = await plugin.openLiteratureLinks(` doi: 10.1038/nature12373
https://example.com/paper
10.1038/nature12373`);

  assert.equal(result.saved.length, 2);
  assert.equal(queued[0], existing);
  assert.equal(queued[1].link, 'https://example.com/paper');
  assert.equal(queued[1].source, '手动导入');
  await assert.rejects(plugin.openLiteratureLinks('10.1038/nature12373\nnot a DOI'), /第 2 行/);
  assert.equal(queued.length, 2);
});

test('CLI literature entry point reuses the existing multi-link import queue', async () => {
  const { plugin } = setup(false);
  const received = [];
  plugin.openLiteratureLinks = async input => { received.push(input); return { saved: [], failures: [] }; };
  await plugin.importLiteratureFromCli('doi: 10.1038/nature12373', 'https://example.com/paper');
  assert.deepEqual(received, ['doi: 10.1038/nature12373\nhttps://example.com/paper']);
});

test('CLI PDF entry point resolves exact vault paths and reuses the MinerU batch queue', async () => {
  const { plugin } = setup(false);
  const pdf = new MockTFile('Papers/one.pdf');
  plugin.app.vault.getAbstractFileByPath = path => path === pdf.path ? pdf : null;
  const received = [];
  plugin.processPdfsWithMinerU = async files => { received.push(files); return { succeeded: 1, failures: [] }; };
  await plugin.processPdfsFromCli('Papers/one.pdf');
  assert.equal(received.length, 1);
  assert.equal(received[0].length, 1);
  assert.equal(received[0][0], pdf);
  await assert.rejects(plugin.processPdfsFromCli('Papers/missing.pdf'), /不是 PDF 或文件不存在/);
});

test('shared batch note queue runs automatically in order and continues after failures', async () => {
  const { plugin } = setup(false);
  const first = { id: 'first', title: 'First', link: 'https://example.com/first', source: 'Manual' };
  const second = { id: 'second', title: 'Second', link: 'https://example.com/second', source: 'Manual' };
  const calls = [];
  plugin.saveArticleAsNote = async (...args) => {
    calls.push(args);
    if (args[0] === first) throw new Error('page unavailable');
    return 'second.md';
  };

  const result = await plugin.saveArticlesAsNotes([first, second]);

  assert.deepEqual(calls.map(args => [args[0].id, args[1], args[2]]), [
    ['first', false, true],
    ['second', false, true],
  ]);
  assert.equal(result.saved.length, 1);
  assert.equal(result.saved[0], second);
  assert.equal(result.failures[0].article, first);
  assert.match(result.failures[0].reason, /page unavailable/);
});

test('interactive batch folder is remembered and passed to every automatic save', async () => {
  const { plugin } = setup(false);
  const articles = [{ id: 'first', title: 'First', link: 'https://example.com/first' }];
  const calls = [];
  plugin.saveArticleAsNote = async (...args) => { calls.push(args); return 'saved.md'; };

  await plugin.saveArticlesAsNotes(articles, 'Papers\\Literature');

  assert.equal(plugin.state.lastLiteratureSaveFolder, 'Papers/Literature');
  assert.equal(calls[0][3], 'Papers/Literature');
});

test('manual capture starts with the default folder and saves to the edited folder', async () => {
  const t = setup(false);
  t.plugin.state.settings.outputFolder = 'Default/RSS';
  const article = { link: 'https://example.com/paper', title: 'Paper', read: false };
  const pending = t.plugin.saveArticleAsNote(article, false);
  assert.equal(t.calls.capture[0][4].outputFolder, 'Default/RSS');
  t.resolveCapture({ url: article.link, html: '<html>Paper</html>', outputFolder: 'Chosen/Folder' });

  await pending;

  assert.equal(t.calls.save[0][2].outputFolder, 'Chosen/Folder');
  assert.equal(t.plugin.state.lastLiteratureSaveFolder, 'Chosen/Folder');
  assert.equal(t.plugin.state.settings.outputFolder, 'Default/RSS');
});

test('batch failures append to AI RSS Reader/faild.md only when no markdown exists', async () => {
  const { plugin, calls } = setup(false);
  const missing = { id: 'missing', title: 'Missing paper', link: 'https://example.com/missing', source: '手动导入' };
  const existing = { id: 'existing', title: 'Existing paper', link: 'https://example.com/existing', source: 'RSS', savedPath: 'saved.md' };
  const another = { id: 'another', title: 'Another paper', link: 'https://example.com/another', source: 'RSS' };
  plugin.saveArticleAsNote = async () => { throw new Error('capture failed'); };

  await plugin.saveArticlesAsNotes([missing, existing]);
  await plugin.saveArticlesAsNotes([another]);

  assert.equal(calls.created.length, 1);
  assert.equal(calls.created[0].path, 'AI RSS Reader/faild.md');
  assert.match(calls.created[0].content, /^# 文献抓取失败记录/);
  assert.match(calls.created[0].content, /Missing paper[\s\S]*https:\/\/example\.com\/missing[\s\S]*capture failed/);
  assert.match(calls.created[0].content, /Another paper[\s\S]*https:\/\/example\.com\/another/);
  assert.doesNotMatch(calls.created[0].content, /Existing paper|example\.com\/existing/);
});

test('manual URL reuses the RSS article including analysis and saved path', async () => {
  const { plugin } = setup(false);
  const article = { link: 'https://doi.org/10.1038/nature12373', savedPath: 'existing.md', analysis: { physics: { relevant: true } } };
  plugin.state.articles = [article];
  plugin.saveArticleAsNote = async received => { assert.equal(received, article); return received.savedPath; };
  assert.equal(await plugin.openLiteratureLink('10.1038/nature12373'), 'existing.md');
});

test('arXiv capture and saving bypass proxy without changing global settings', async () => {
  const t = setup(true);
  const article = { link: 'https://arxiv.org/abs/1706.03762', title: 'Paper' };
  const pending = t.plugin.saveArticleAsNote(article, false);
  assert.equal(t.calls.capture[0][2], '');
  t.resolveCapture({ url: article.link, html: '<html>Article</html>' });
  await pending;
  assert.equal(t.calls.save[0][2].ezProxyEnabled, false);
  assert.equal(t.plugin.state.settings.ezProxyEnabled, true);
});

test('automatic batch capture closes its browser tab only after the package is saved', async () => {
  const t = setup(false);
  t.plugin.state.settings.batchCaptureIntervalSeconds = 2.4;
  const article = { link: 'https://example.com/batch-paper', title: 'Batch paper', read: false };
  let closed = 0;
  const pending = t.plugin.saveArticleAsNote(article, false, true);
  assert.equal(t.calls.capture[0][4].automatic, true);
  assert.equal(t.calls.capture[0][4].background, true);
  assert.equal(t.calls.capture[0][4].retryIntervalMs, 2400);
  t.resolveCapture({ url: article.link, html: '<html>Paper</html>', close: () => { closed++; } });
  assert.equal(await pending, 'saved.md');
  assert.equal(t.calls.save.length, 1);
  assert.equal(closed, 1);
  assert.equal(t.calls.opened.length, 0);
});

for (const proxy of [false, true]) {
  test(`save waits for confirmation and uses its snapshot (${proxy ? 'proxy' : 'direct'})`, async () => {
    const t = setup(proxy);
    const article = { link: 'https://journals.aps.org/prx/abstract/10.1103/jvv7-z2fq', title: 'Paper', savedPath: 'old.md', read: false };
    const pending = t.plugin.saveArticleAsNote(article, false);
    assert.equal(t.calls.capture.length, 1);
    assert.equal(t.calls.capture[0][2], proxy ? 'https://sutd.idm.oclc.org' : '');
    assert.equal(t.calls.save.length, 0);
    assert.equal(article.savedPath, 'old.md');
    await assert.rejects(t.plugin.saveArticleAsNote(article, false), /该文献已在/);
    const page = { url: article.link, html: '<html>Rendered full text</html>' };
    t.resolveCapture(page);
    assert.equal(await pending, 'saved.md');
    assert.equal(t.calls.save.length, 1);
    assert.equal(t.calls.save[0][3], page);
    assert.equal(t.calls.state, 1);
  });

  test(`cancel does not save or change article state (${proxy ? 'proxy' : 'direct'})`, async () => {
    const t = setup(proxy);
    const article = { link: 'https://journals.aps.org/paper', title: 'Paper', savedPath: 'old.md', read: false };
    const pending = t.plugin.saveArticleAsNote(article, false);
    t.rejectCapture(new Error('已取消文献采集'));
    await assert.rejects(pending, /已取消/);
    assert.equal(t.calls.save.length, 0);
    assert.equal(t.calls.state, 0);
    assert.equal(article.savedPath, 'old.md');
    assert.equal(article.read, false);
    // A cancelled attempt releases this article's capture guard.
    const retry = t.plugin.saveArticleAsNote(article, false);
    assert.equal(t.calls.capture.length, 2);
    t.captureDeferreds[1].reject(new Error('已取消文献采集'));
    await assert.rejects(retry, /已取消/);
  });
}

test('different articles can wait, capture, and save concurrently', async () => {
  const t = setup(false);
  const first = { id: 'first', link: 'https://example.com/paper-1', title: 'First', read: false };
  const second = { id: 'second', link: 'https://example.com/paper-2', title: 'Second', read: false };
  const firstPending = t.plugin.saveArticleAsNote(first, false);
  const secondPending = t.plugin.saveArticleAsNote(second, false);
  assert.equal(t.calls.capture.length, 2);
  assert.notEqual(t.calls.capture[0][3], t.calls.capture[1][3]);

  const secondPage = { url: second.link, html: '<html>Second</html>' };
  t.captureDeferreds[1].resolve(secondPage);
  assert.equal(await secondPending, 'saved.md');
  assert.equal(t.calls.save[0][1], second);
  assert.equal(t.calls.save[0][3], secondPage);

  const firstPage = { url: first.link, html: '<html>First</html>' };
  t.captureDeferreds[0].resolve(firstPage);
  assert.equal(await firstPending, 'saved.md');
  assert.equal(t.calls.save[1][1], first);
  assert.equal(t.calls.save[1][3], firstPage);
});

test('five-category batch changes can be undone without overwriting saved note paths', async () => {
  const { plugin } = setup(false);
  plugin.getView = () => ({ render() {} });
  const original = { id: 'classification', title: 'Test', read: false, fetchedAt: '2026-09-09', savedPath: undefined };
  plugin.state.articles = [original];
  await plugin.classifyArticles([original], 'interested');
  assert.equal(original.status, 'interested');
  assert.equal(original.read, true);
  assert.equal(plugin.canUndoStatus, true);
  original.savedPath = 'newly-saved.md';
  await plugin.undoClassification();
  assert.equal(original.status, undefined);
  assert.equal(original.read, false);
  assert.equal(original.savedPath, 'newly-saved.md');
  assert.equal(plugin.canUndoStatus, false);
});
