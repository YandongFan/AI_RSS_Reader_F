const assert = require('node:assert/strict');
const { test } = require('node:test');
const { transformSync } = require('esbuild');
const { readFileSync } = require('node:fs');

const source = readFileSync('src/table-columns.ts', 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const tableModule = { exports: {} };
new Function('module', 'exports', code)(tableModule, tableModule.exports);
const { resizeTableColumns } = tableModule.exports;

const widths = { select: 38, title: 285, source: 156, profiles: 110, reason: 267, date: 110 };

test('resizing a column moves the boundary and keeps the adjacent column width balanced', () => {
  const resized = resizeTableColumns(widths, 'title', 'source', 40);
  assert.equal(resized.title, 325);
  assert.equal(resized.source, 116);
  assert.equal(widths.title, 285);
  assert.equal(widths.source, 156);
});

test('resizing never makes a column narrower than the minimum', () => {
  const resized = resizeTableColumns(widths, 'title', 'source', 500);
  assert.equal(resized.source, 48);
  assert.equal(resized.title, 393);
});
