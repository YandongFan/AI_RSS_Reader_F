const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { parseLinkedomHTML } = require('../node_modules/defuddle/dist/utils/linkedom-compat.js');
const code = buildSync({ entryPoints: ['src/literature.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external' }).outputFiles[0].text;
const base = 'https://journals-aps-org.sutd.idm.oclc.org/prx/abstract/10.1103/szqp-wp6h';
const pdf = base.replace('/abstract/', '/pdf/');
const meta = 'http://link.aps.org/pdf/10.1103/szqp-wp6h';
const settings = { ezProxyEnabled: true, ezProxyPrefix: 'https://sutd.idm.oclc.org/login?url=$@' };
const doc = html => parseLinkedomHTML(`<html><head><base href="${base}"></head><body>${html}</body></html>`);
const response = (text, type = 'text/html') => ({ status: 200, headers: { 'content-type': type }, arrayBuffer: new TextEncoder().encode(text).buffer });
function load(requestUrl, cookieUrls = []) {
  const sandbox = { module: { exports: {} }, exports: {}, URL, TextDecoder,
    DOMParser: class { parseFromString(html) { return parseLinkedomHTML(html); } },
    require: name => name === 'obsidian' ? { requestUrl } : name === 'electron' ? { remote: { session: { fromPartition: () => ({ cookies: { get: async ({ url }) => { cookieUrls.push(url); return []; } } }) } } } : require(name) };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}
test('prefers the page proxy PDF over metadata and excludes supplements', () => {
  const { findPdfUrls } = load();
  const urls = findPdfUrls({ link: 'http://link.aps.org/doi/10.1103/szqp-wp6h' }, doc(`<meta name="citation_pdf_url" content="${meta}"><a href="/supplemental/file.pdf">Supplemental Material</a><a href="/prx/pdf/10.1103/szqp-wp6h">PDF</a>`));
  assert.deepEqual(Array.from(urls), [pdf, meta]);
});
test('requests the existing proxy host and its cookies without a login redirect', async () => {
  const calls = [], cookieUrls = [];
  const { downloadPdf } = load(async r => { calls.push(r.url); return response('%PDF-test', 'application/pdf'); }, cookieUrls);
  await downloadPdf({ getWebviewPartition: () => 'test' }, [pdf, meta], settings);
  assert.deepEqual(calls, [pdf]);
  assert.deepEqual(cookieUrls, [pdf]);
});
test('prefers the visible PDF link over a same-origin head link', () => {
  const { findPdfUrls } = load();
  const page = parseLinkedomHTML('<html><head><base href="https://www.nature.com/articles/example"><link type="application/pdf" href="/articles/example.pdf"></head><body><a href="/articles/example_reference.pdf">Download PDF</a></body></html>');
  assert.deepEqual(Array.from(findPdfUrls({ link: 'https://www.nature.com/articles/example' }, page)), [
    'https://www.nature.com/articles/example_reference.pdf', 'https://www.nature.com/articles/example.pdf',
  ]);
});
test('retries after HTML and HTTP failures, accepting only PDF bytes', async () => {
  let count = 0;
  const { downloadPdf } = load(async () => ++count === 1 ? response('<html><form action="/login"></form></html>') : count === 2 ? { ...response('denied'), status: 403 } : response('%PDF-test'));
  await downloadPdf({}, ['https://a.org/pdf/1', 'https://a.org/pdf/2', 'https://a.org/pdf/3'], { ezProxyEnabled: false });
  assert.equal(count, 3);
});
test('reports a login page explicitly when all candidates fail', async () => {
  const { downloadPdf } = load(async () => response('<html><form action="/login"></form></html>'));
  await assert.rejects(downloadPdf({}, [pdf], { ezProxyEnabled: false }), /返回了登录页面.*HTTP 200.*text\/html/);
});
test('follows Wiley reader source for the same DOI without evaluating scripts', async () => {
  const calls = [];
  const { downloadPdf } = load(async r => {
    calls.push(r.url);
    return calls.length === 1 ? response('<html><script>var src = "/doi/pdfdirect/10.1002/adma.74896";</script></html>') : response('%PDF-test');
  });
  await downloadPdf({}, ['https://advanced.onlinelibrary.wiley.com/doi/pdf/10.1002/adma.74896'], { ezProxyEnabled: false });
  assert.deepEqual(calls, ['https://advanced.onlinelibrary.wiley.com/doi/pdf/10.1002/adma.74896', 'https://advanced.onlinelibrary.wiley.com/doi/pdfdirect/10.1002/adma.74896']);
});
test('does not follow a reader source for a different DOI', async () => {
  let calls = 0;
  const { downloadPdf } = load(async () => { calls++; return response('<html><script>var src = "/doi/pdfdirect/10.1002/other";</script></html>'); });
  await assert.rejects(downloadPdf({}, ['https://advanced.onlinelibrary.wiley.com/doi/pdf/10.1002/adma.74896'], { ezProxyEnabled: false }), /不是 PDF/);
  assert.equal(calls, 1);
});
