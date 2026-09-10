const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { parseLinkedomHTML } = require('../node_modules/defuddle/dist/utils/linkedom-compat.js');
const code = buildSync({ entryPoints: ['src/attachments.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
const sandbox = { module: { exports: {} }, exports: {}, URL, TextDecoder, Uint8Array };
vm.runInNewContext(code, sandbox);
const { attachmentKind, findAttachments, attachmentExtension, downloadAttachments } = sandbox.module.exports;
const base = 'https://publisher.example/article/123';
const parse = html => parseLinkedomHTML(`<html><head></head><body>${html}</body></html>`);
const response = (text, type = '', disposition = '') => ({ arrayBuffer: new TextEncoder().encode(text).buffer, headers: { 'Content-Type': type, 'Content-Disposition': disposition } });

test('filters supplementary types before requests and after response detection, including landing pages', async () => {
  const requested = [], saved = [];
  const links = ['skip.ZIP', 'landing', 'download-office', 'download-data', 'disguised.pdf'].map(path => ({ url: `${base}/${path}`, kind: 'supplementary', label: 'Supplement' }));
  links.push({ url: `${base}/review.zip`, kind: 'peer-review', label: 'Review' });
  const result = await downloadAttachments(links, () => true, async url => {
    requested.push(url);
    if (url.endsWith('/landing')) return response('<a href="yes.PDF">Download</a><a href="skip.csv">Download</a>', 'text/html');
    if (url.endsWith('/download-office')) return response('PK\x03\x04data', '', 'attachment; filename="data.docx"');
    if (url.endsWith('/download-data')) return response('a,b', 'text/csv');
    if (url.endsWith('/disguised.pdf')) return response('PK\x03\x04data', '', 'attachment; filename="data.zip"');
    if (url.endsWith('/review.zip')) return response('PK\x03\x04data');
    return response('%PDF-1.7');
  }, async (link, ext) => { saved.push(ext); return link.url; }, parse, ['pdf', 'docx']);
  assert.deepEqual(saved, ['docx', 'zip', 'pdf']);
  assert.equal(requested.some(url => /skip\.(ZIP|csv)$/.test(url)), false);
  assert.equal(result.warnings.length, 0);
});

test('empty selection skips supplementary files and landing pages but preserves peer review', async () => {
  const requested = [];
  const links = [
    { url: `${base}/landing`, kind: 'supplementary', label: 'Supplement' },
    { url: `${base}/review.pdf`, kind: 'peer-review', label: 'Review' },
  ];
  const result = await downloadAttachments(links, () => true, async url => {
    requested.push(url); return response('%PDF-1.7');
  }, async link => link.url, parse, []);
  assert.deepEqual(requested, [`${base}/review.pdf`]);
  assert.equal(result.files.length, 1);
  assert.equal(result.warnings.length, 0);
});

test('filters peer-review types independently from supplementary types', async () => {
  const requested = [], saved = [];
  const links = [
    { url: `${base}/supplement.pdf`, kind: 'supplementary', label: 'Supplement' },
    { url: `${base}/review.pdf`, kind: 'peer-review', label: 'Review PDF' },
    { url: `${base}/review.docx`, kind: 'peer-review', label: 'Review Word' },
    { url: `${base}/review-download`, kind: 'peer-review', label: 'Review data' },
  ];
  const result = await downloadAttachments(links, () => true, async url => {
    requested.push(url);
    if (url.endsWith('.docx')) return response('PK\x03\x04data', '', 'attachment; filename="review.docx"');
    if (url.endsWith('review-download')) return response('a,b', 'text/csv');
    return response('%PDF-1.7');
  }, async (link, ext) => { saved.push(`${link.kind}:${ext}`); return link.url; }, parse, ['pdf'], ['docx']);
  assert.deepEqual(saved, ['supplementary:pdf', 'peer-review:docx']);
  assert.equal(requested.some(url => url.endsWith('/review.pdf')), false);
  assert.equal(requested.some(url => url.endsWith('/review-download')), true);
  assert.equal(result.warnings.length, 0);
});

test('recognizes naming variants and publisher file patterns', () => {
  for (const label of ['Supporting Information', 'Supplementary Material', 'Supplemental data', 'Additional file 1', 'Electronic Supplementary Material', 'Source Data', 'Appendix', '补充材料', 'paper_MOESM1_ESM.pdf', '/suppl_file/paper_s001.pdf']) assert.equal(attachmentKind(label), 'supplementary', label);
  for (const label of ['Peer-review file', 'Peer Review History', 'Reviewer reports', 'Referee Report', 'Author response', 'Response to reviewers', 'Decision letter', 'Review process', '同行评审']) assert.equal(attachmentKind(label), 'peer-review', label);
  assert.equal(attachmentKind('Review article'), undefined);
  assert.equal(attachmentKind('Download PDF'), undefined);
});

test('resolves proxy-relative URLs, section context, deduplication and excludes navigation', () => {
  const doc = parse(`<article><a href="main.pdf">Download PDF</a><section><h2>Supporting Information</h2><p><a href="files/one.pdf">Download</a></p><a href="files/one.pdf#page=2">Supplementary Material</a><a href="#supplement">Supporting Information</a></section><section><h2>Peer Review</h2><div><a href="/download?id=12">Report</a></div></section><a href="javascript:void(0)">Supplementary</a></article>`);
  const links = findAttachments(doc, 'https://publisher-example.proxy.edu/article/123');
  assert.equal(links.length, 2);
  assert.equal(links[0].url, 'https://publisher-example.proxy.edu/article/files/one.pdf');
  assert.equal(links[1].kind, 'peer-review');
  assert.equal(links[1].url, 'https://publisher-example.proxy.edu/download?id=12');
});

test('validates PDF/ZIP, supports header filenames, rejects HTML and empty content', () => {
  assert.equal(attachmentExtension(response('%PDF-1.7'), base), 'pdf');
  assert.equal(attachmentExtension(response('PK\x03\x04data', '', "attachment; filename*=UTF-8''supplement.xlsx"), base), 'xlsx');
  assert.equal(attachmentExtension(response('a,b\n1,2', 'text/csv'), base), 'csv');
  assert.throws(() => attachmentExtension(response('<html>login</html>'), base + '/data.pdf'), /网页/);
  assert.throws(() => attachmentExtension(response('login', 'application/pdf'), base), /不是 PDF/);
  assert.throws(() => attachmentExtension(response('bad'), base + '/data.zip'), /格式/);
  assert.throws(() => attachmentExtension(response(''), base), /为空/);
});

test('downloads multiple files through one landing page, preserves partial success and honors switches', async () => {
  const requested = [], saved = [];
  const links = [
    { url: base + '/supplement', kind: 'supplementary', label: 'Supplement' },
    { url: base + '/bad.pdf', kind: 'supplementary', label: 'Supplementary' },
    { url: base + '/review.pdf', kind: 'peer-review', label: 'Peer review' },
  ];
  const result = await downloadAttachments(links, kind => kind === 'supplementary', async url => {
    requested.push(url);
    if (url.endsWith('/supplement')) return response('<a href="one.pdf">Download</a><a href="two.csv">Data</a><a href="one.pdf#p2">Duplicate</a>', 'text/html');
    if (url.endsWith('bad.pdf')) return response('<html>Sign in</html>', 'text/html');
    return url.endsWith('one.pdf') ? response('%PDF-1.7') : response('x,y\n1,2', 'text/csv');
  }, async (link, ext, data, index) => { const path = `folder/${link.kind}-${index}.${ext}`; saved.push(path); return path; }, parse);
  assert.equal(result.files.length, 2);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /bad.pdf/);
  assert.equal(requested.some(url => url.endsWith('review.pdf')), false);
  assert.equal(requested.filter(url => url.endsWith('one.pdf')).length, 1);
  assert.deepEqual(saved, ['folder/supplementary-1.pdf', 'folder/supplementary-2.csv']);
});
