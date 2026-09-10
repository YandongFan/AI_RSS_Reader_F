const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.title = '';
  }

  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName);
    child.textContent = options.text ?? '';
    child.className = options.cls ?? '';
    this.children.push(child);
    return child;
  }

  createSpan(options = {}) { return this.createEl('span', options); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  closest(selector) { return selector.toUpperCase() === this.tagName ? this : null; }
  dispatch(name, event) { return this.listeners.get(name)?.(event); }
}

class FakeRow extends FakeElement {
  constructor() {
    super('tr');
    this.cells = [];
  }

  insertCell() {
    const cell = new FakeElement('td');
    this.cells.push(cell);
    this.children.push(cell);
    return cell;
  }
}

function loadView(notices = []) {
  const code = require('esbuild').buildSync({ entryPoints: ['src/view.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;
  const sandbox = {
    structuredClone,
    module: { exports: {} }, exports: {},
    require: name => {
      if (name === 'obsidian') return {
        ItemView: class {}, Modal: class {}, Notice: class { constructor(message) { notices.push(message); } }, setIcon() {},
      };
      if (['./article-state', './article-image', './recommendation'].includes(name)) {
        const code = require('esbuild').buildSync({ entryPoints: [`src/${name.slice(2)}.ts`], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
        const mod = { exports: {} };
        new Function('module', 'exports', code)(mod, mod.exports);
        return mod.exports;
      }
      if (name === './literature-input') return { normalizeLiteratureInputs: value => [value] };
      if (name === './table-columns') {
        const compiled = transformSync(readFileSync('src/table-columns.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code;
        const tableModule = { exports: {} };
        new Function('module', 'exports', compiled)(tableModule, tableModule.exports);
        return tableModule.exports;
      }
      return require(name);
    },
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports.AiRssView;
}

test('batch save runs unattended sequentially and continues after an article fails', async () => {
  const notices = [];
  const AiRssView = loadView(notices);
  const first = { id: 'first', title: 'First' };
  const second = { id: 'second', title: 'Second' };
  const calls = [];
  const view = Object.create(AiRssView.prototype);
  view.selectedIds = new Set(['first', 'second']);
  view.plugin = {
    state: { articles: [first, second] },
    saveArticlesAsNotes: async (articles, outputFolder) => {
      calls.push({ articles, outputFolder });
      return { saved: [second], failures: [{ article: first, reason: 'page unavailable' }] };
    },
  };
  let renders = 0;
  view.render = () => { renders++; };

  await view.saveSelectedNotes('Papers/Batch');

  assert.deepEqual(calls.map(call => ({ ids: call.articles.map(article => article.id), outputFolder: call.outputFolder })), [
    { ids: ['first', 'second'], outputFolder: 'Papers/Batch' },
  ]);
  assert.deepEqual([...view.selectedIds], []);
  assert.equal(renders, 1);
  assert.match(notices.at(-1), /成功 1 篇，失败 1 篇.*First.*page unavailable/);
});

test('marking selected articles read or unread clears the selection before rendering', async () => {
  const AiRssView = loadView();
  const first = { id: 'first', read: false };
  const second = { id: 'second', read: true };
  const calls = [];
  const view = Object.create(AiRssView.prototype);
  view.selectedIds = new Set(['first', 'second']);
  view.plugin = {
    state: { articles: [first, second] },
    setArticlesRead: async (articles, read) => {
      calls.push({ ids: articles.map(article => article.id), read, selectionDuringCall: [...view.selectedIds] });
    },
  };

  await view.setSelectedRead(true);
  assert.deepEqual(calls, [{ ids: ['first', 'second'], read: true, selectionDuringCall: [] }]);
  assert.deepEqual([...view.selectedIds], []);

  view.selectedIds = new Set(['first']);
  await view.setSelectedRead(false);
  assert.deepEqual(calls.at(-1), { ids: ['first'], read: false, selectionDuringCall: [] });
  assert.deepEqual([...view.selectedIds], []);
});

test('clicking a title opens the browser capture flow without changing selection', async () => {
  const AiRssView = loadView();
  const calls = { save: [], markRead: [], renders: 0 };
  const view = Object.create(AiRssView.prototype);
  view.selectedIds = new Set(['paper-2']);
  view.plugin = {
    saveArticleAsNote: async article => { calls.save.push(article.id); },
    markArticleRead: async article => { calls.markRead.push(article.id); },
  };
  view.renderArticles = () => { calls.renders++; };
  const article = {
    id: 'paper-1', title: 'Paper title', link: 'https://example.com/paper', source: 'Journal',
    summary: '', published: '2026-09-05', fetchedAt: '2026-09-05', read: false,
    matchedProfiles: [], analysis: {},
  };
  let row;
  const body = { insertRow: () => (row = new FakeRow()) };
  view.renderTableRow(body, article, new FakeElement(), [article]);
  const title = row.cells[1].children[0];
  let propagationStopped = false;

  title.dispatch('click', { shiftKey: true, stopPropagation: () => { propagationStopped = true; } });
  await Promise.resolve();

  assert.equal(propagationStopped, true);
  assert.deepEqual(calls.markRead, ['paper-1']);
  assert.deepEqual(calls.save, ['paper-1']);
  assert.deepEqual([...view.selectedIds], ['paper-2']);
  assert.equal(calls.renders, 0);
});

test('clicking a non-title data cell selects the article without opening it', () => {
  const AiRssView = loadView();
  const calls = { save: [], renders: 0 };
  const view = Object.create(AiRssView.prototype);
  view.selectedIds = new Set();
  view.plugin = { saveArticleAsNote: async article => { calls.save.push(article.id); } };
  view.renderArticles = () => { calls.renders++; };
  const article = {
    id: 'paper-1', title: 'Paper title', link: 'https://example.com/paper', source: 'Journal',
    summary: '', published: '2026-09-05', fetchedAt: '2026-09-05', read: true,
    matchedProfiles: [], analysis: {},
  };
  let row;
  const body = { insertRow: () => (row = new FakeRow()) };
  const root = new FakeElement();
  view.renderTableRow(body, article, root, [article]);

  row.dispatch('click', { target: row.cells[2], shiftKey: false });

  assert.equal(view.selectedIds.has('paper-1'), true);
  assert.deepEqual(calls.save, []);
  assert.equal(calls.renders, 1);
});
