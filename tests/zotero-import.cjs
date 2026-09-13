const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSync } = require('esbuild');

class TFile {
  constructor(path) { this.path = path; this.name = path.split('/').pop(); this.extension = this.name.split('.').pop(); this.basename = this.name.slice(0, -(this.extension.length + 1)); }
}
class TFolder {
  constructor(path, children = []) { this.path = path; this.name = path.split('/').pop(); this.children = children; for (const child of children) child.parent = this; }
}
function load(entry, mocks = {}) {
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', code)(mod, mod.exports, name => mocks[name] || require(name));
  return mod.exports;
}
const { ZoteroImportJob } = load('src/zotero-client.ts');
const ui = load('src/zotero-import.ts', { obsidian: { TFile, TFolder, Modal: class {} } });
const files = ['paper.pdf', '补充材料.zip', 'peer-review.pdf'].map(name => ({ path: `paper/${name}`, name, contentType: name.endsWith('.zip') ? 'application/zip' : 'application/pdf' }));
const source = { title: 'Paper', item: { title: 'Paper', itemType: 'journalArticle', DOI: '10.1234/test' }, files };
const read = async path => Uint8Array.from([0, 255, path.length, 10]).buffer;
function harness(override = () => undefined) {
  const calls = [];
  const send = async (path, body, type, headers) => {
    const call = { path, body, type, headers, json: type === 'application/json' ? JSON.parse(body) : undefined };
    calls.push(call);
    const replacement = await override(call);
    if (replacement) return replacement;
    if (path === 'getSelectedCollection') return { status: 200, text: JSON.stringify({ libraryID: 1, id: null, targets: [{ id: 'L1', name: 'My Library', filesEditable: true, level: 0 }, { id: 'C5', name: 'Selected', filesEditable: true, level: 1 }, { id: 'C6', name: 'Read only', filesEditable: false, level: 1 }] }) };
    return { status: path === 'updateSession' ? 200 : 201, text: '' };
  };
  return { calls, job: new ZoteroImportJob(source, send) };
}

test('creates one parent, moves to selected collection, and copies exact bytes under that parent', async () => {
  const { job, calls } = harness();
  await job.run('C5', read, () => {});
  assert.deepEqual(calls.map(call => call.path), ['getSelectedCollection', 'saveItems', 'updateSession', 'saveAttachment', 'saveAttachment', 'saveAttachment']);
  assert.equal(calls[2].json.target, 'C5');
  assert.equal(calls[1].json.items.length, 1);
  assert.deepEqual(calls[1].json.items[0].attachments, []);
  for (let i = 0; i < files.length; i++) {
    const attachment = calls[i + 3];
    const metadata = JSON.parse(attachment.headers['X-Metadata']);
    assert.equal(metadata.parentItemID, calls[1].json.items[0].id);
    assert.equal(metadata.sessionID, calls[1].json.sessionID);
    assert.equal(metadata.title, files[i].name);
    assert.match(metadata.url, /^http:\/\/127\.0\.0\.1:23119\//);
    assert.ok(!/[^\x00-\x7f]/.test(attachment.headers['X-Metadata']));
    assert.deepEqual(attachment.body, Buffer.from(await read(files[i].path)));
  }
  assert.equal(job.uploaded.size, 3);
  await job.run('L1', read, () => {});
  assert.equal(calls.filter(call => call.path === 'saveItems').length, 1);
  assert.equal(calls.filter(call => call.path === 'saveAttachment').length, 3);
});

test('attachment failure is reported and retry uploads only the failed file to the same parent', async () => {
  let fail = true;
  const { job, calls } = harness(call => {
    if (call.path === 'saveAttachment' && JSON.parse(call.headers['X-Metadata']).title === files[1].name && fail) return { status: 500, text: '' };
  });
  await assert.rejects(job.run('C5', read, () => {}), /已导入 2\/3.*未完成：[\s\S]*补充材料.zip/);
  fail = false;
  await job.run('C5', read, () => {});
  assert.equal(calls.filter(call => call.path === 'saveItems').length, 1);
  assert.equal(calls.filter(call => call.path === 'saveAttachment').length, 4);
  assert.equal(job.uploaded.size, 3);
});

test('invalid collection and unreadable local file do not create a parent', async () => {
  for (const target of ['C6', 'missing']) {
    const { job, calls } = harness();
    await assert.rejects(job.run(target, read, () => {}), /目标分类/);
    assert.equal(calls.length, 1);
  }
  const { job, calls } = harness();
  await assert.rejects(job.run('L1', async () => { throw Error('missing file'); }, () => {}), /missing file/);
  assert.equal(calls.length, 1);
});

test('lost parent response blocks blind duplicate creation', async () => {
  const { job, calls } = harness(call => { if (call.path === 'saveItems') throw Error('connection reset'); });
  await assert.rejects(job.run('L1', read, () => {}), /connection reset/);
  await assert.rejects(job.run('L1', read, () => {}), /结果不确定/);
  assert.equal(calls.filter(call => call.path === 'saveItems').length, 1);
});

test('HTTP 200 non-writable attachment response is not counted as success', async () => {
  const { job } = harness(call => call.path === 'saveAttachment' ? { status: 200, text: 'Library files are not editable.' } : undefined);
  await assert.rejects(job.run('L1', read, () => {}), /已导入 0\/3/);
  assert.equal(job.uploaded.size, 0);
});

test('concurrent import clicks cannot create two parent items', async () => {
  let release;
  const { job } = harness(async call => { if (call.path === 'getSelectedCollection') await new Promise(resolve => { release = resolve; }); });
  const first = job.run('L1', read, () => {});
  await assert.rejects(job.run('L1', read, () => {}), /正在导入/);
  release();
  await first;
});

test('package includes PDF, supplements and review files but excludes Markdown, BibTeX and derived folders', () => {
  const note = new TFile('paper/paper.md');
  const derived = new TFolder('paper/Miner_U', [new TFile('paper/Miner_U/image.png'), new TFile('paper/Miner_U/output.md')]);
  const supplements = new TFolder('paper/supplementary', [new TFile('paper/supplementary/data.xlsx'), new TFile('paper/supplementary/README.MD'), new TFile('paper/supplementary/reference.BiB')]);
  new TFolder('paper', [note, new TFile('paper/paper.pdf'), new TFile('paper/paper.bib'), new TFile('paper/paper-peer-review-1.pdf'), new TFile('paper/extra-notes.md'), derived, supplements]);
  const result = ui.makeZoteroPackage(note, { title: '中文标题', authors: ['Jane Doe'], doi: '10.1234/test', journal: 'Test Journal', year: 2026 });
  assert.deepEqual(result.files.map(file => file.name).sort(), ['data.xlsx', 'paper-peer-review-1.pdf', 'paper.pdf']);
  assert.equal(result.item.title, '中文标题');
  assert.equal(result.item.DOI, '10.1234/test');
  assert.equal(result.item.creators[0].lastName, 'Jane Doe');
  assert.equal(result.item.date, '2026');
});

test('a folder containing only Markdown and BibTeX has no upload candidates but retains item metadata', () => {
  const note = new TFile('paper/paper.md');
  new TFolder('paper', [note, new TFile('paper/paper.bib'), new TFile('paper/README.Md'), new TFile('paper/REFERENCE.BIB')]);
  const result = ui.makeZoteroPackage(note, { title: 'Paper', doi: '10.1234/test' });
  assert.deepEqual(result.files, []);
  assert.equal(result.item.DOI, '10.1234/test');
});

test('context menu is restricted to identified literature notes and their own folder', () => {
  const note = new TFile('paper/paper.md');
  const folder = new TFolder('paper', [note]);
  const root = new TFolder('', [folder]);
  const app = { metadataCache: { getFileCache: file => ({ frontmatter: { tags: file === note ? ['ai-rss-reader'] : [] } }) } };
  const titles = [];
  const menu = { addItem(callback) { const item = { setTitle(value) { titles.push(value); return item; }, setIcon() { return item; }, onClick() { return item; } }; callback(item); } };
  ui.addZoteroFileMenu(app, menu, folder, []);
  ui.addZoteroFileMenu(app, menu, note, []);
  ui.addZoteroFileMenu(app, menu, root, []);
  ui.addZoteroFileMenu(app, menu, new TFolder('unrelated', [new TFile('unrelated/file.md')]), []);
  const second = new TFile('paper/second.md');
  folder.children.push(second);
  second.parent = folder;
  ui.addZoteroFileMenu(app, menu, folder, [{ savedPath: second.path }]);
  ui.addZoteroFileMenu(app, menu, note, [{ savedPath: second.path }]);
  assert.deepEqual(titles, ['导入到Zotero', '导入到Zotero']);
});
