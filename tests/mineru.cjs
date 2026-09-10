const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');
const { zipSync, strToU8 } = require('fflate');

const code = buildSync({
  entryPoints: ['src/mineru.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['obsidian', 'electron'],
}).outputFiles[0].text;

function load() {
  const sandbox = {
    module: { exports: {} }, exports: {}, URL, TextDecoder, TextEncoder, Buffer,
    require: name => name === 'obsidian'
      ? { requestUrl: async () => { throw new Error('unexpected request'); }, normalizePath: value => value }
      : require(name),
  };
  vm.runInNewContext(code, sandbox);
  return sandbox.module.exports;
}

function settings(overrides = {}) {
  return {
    mineruToken: '', mineruModelVersion: 'vlm', mineruLanguage: 'en', mineruOcr: false,
    mineruEnableTable: true, mineruEnableFormula: true, mineruSaveMarkdown: true,
    mineruSaveContentListJson: true, mineruSaveLayoutJson: true, mineruSaveModelJson: true,
    mineruSaveImages: true, mineruSaveOtherFiles: false, ...overrides,
  };
}

function response(json = {}, options = {}) {
  const text = options.text ?? JSON.stringify(json);
  const bytes = options.arrayBuffer ?? new TextEncoder().encode(text).buffer;
  return { status: options.status ?? 200, headers: {}, json, text, arrayBuffer: bytes };
}

test('uses the token standard API, uploads the PDF, polls, and downloads the ZIP', async () => {
  const { parsePdfWithMinerU } = load();
  const calls = [];
  const zip = new Uint8Array([1, 2, 3]).buffer;
  const requester = async request => {
    calls.push(request);
    if (request.url.endsWith('/file-urls/batch')) return response({ code: 0, data: { batch_id: 'batch-1', file_urls: ['https://upload.test/file'] } });
    if (request.url === 'https://upload.test/file') return response();
    if (request.url.includes('/extract-results/batch/')) return response({ code: 0, data: { extract_result: [{ state: 'done', full_zip_url: 'https://download.test/result.zip' }] } });
    if (request.url === 'https://download.test/result.zip') return response({}, { arrayBuffer: zip });
    throw new Error(`unexpected URL ${request.url}`);
  };
  const result = await parsePdfWithMinerU(new Uint8Array([37, 80, 68, 70]).buffer, 'paper.pdf', settings({ mineruToken: 'secret' }), () => {}, requester, async () => {});
  assert.equal(result.mode, 'standard');
  assert.deepEqual(Array.from(new Uint8Array(result.archive)), [1, 2, 3]);
  assert.equal(calls[0].headers.Authorization, 'Bearer secret');
  assert.equal(calls[1].method, 'PUT');
  assert.match(calls[0].body, /"model_version":"vlm"/);
  assert.equal(JSON.parse(calls[0].body).files[0].is_ocr, false);
});

test('uses the token-free Agent API and returns downloaded Markdown', async () => {
  const { parsePdfWithMinerU } = load();
  const calls = [];
  const requester = async request => {
    calls.push(request);
    if (request.url.endsWith('/parse/file')) return response({ code: 0, data: { task_id: 'task-1', file_url: 'https://upload.test/file' } });
    if (request.url === 'https://upload.test/file') return response();
    if (request.url.endsWith('/parse/task-1')) return response({ code: 0, data: { state: 'done', markdown_url: 'https://download.test/full.md' } });
    if (request.url === 'https://download.test/full.md') return response({}, { text: '# Parsed' });
    throw new Error(`unexpected URL ${request.url}`);
  };
  const result = await parsePdfWithMinerU(new ArrayBuffer(2), 'paper.pdf', settings(), () => {}, requester, async () => {});
  assert.equal(result.mode, 'agent');
  assert.equal(result.markdown, '# Parsed');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('renames complete ZIP outputs and orders images by Markdown references', () => {
  const { buildArchiveOutputs } = load();
  const archiveBytes = zipSync({
    'paper/full.md': strToU8('See [1].\n\nFirst ![](images/b.png) then ![](images/a.png)\n\n## References\n\n[1] Example reference.'),
    'paper/images/a.png': new Uint8Array([1]),
    'paper/images/b.png': new Uint8Array([2]),
    'paper/paper_content_list.json': strToU8('{"kind":"content"}'),
    'paper/paper_middle.json': strToU8('{"kind":"layout"}'),
    'paper/paper_model.json': strToU8('{"kind":"model"}'),
  });
  const archive = archiveBytes.buffer.slice(archiveBytes.byteOffset, archiveBytes.byteOffset + archiveBytes.byteLength);
  const outputs = buildArchiveOutputs(archive, 'Papers/Miner_U', 'Paper_MinerU', settings(), bytes => bytes);
  const byPath = new Map(outputs.map(output => [output.path, output.data]));
  assert.equal(byPath.get('Papers/Miner_U/Figures/Paper_MinerU_1.jpg')[0], 2);
  assert.equal(byPath.get('Papers/Miner_U/Figures/Paper_MinerU_2.jpg')[0], 1);
  assert.equal(byPath.get('Papers/Miner_U/Paper_MinerU.md'), 'See [^1].\n\nFirst ![](Figures/Paper_MinerU_1.jpg) then ![](Figures/Paper_MinerU_2.jpg)\n\n## References\n\n[^1]: Example reference.');
  assert.ok(byPath.has('Papers/Miner_U/Paper_MinerU_content_list.json'));
  assert.ok(byPath.has('Papers/Miner_U/Paper_MinerU_layout.json'));
  assert.ok(byPath.has('Papers/Miner_U/Paper_MinerU_model.json'));
});

test('postprocesses numeric citations and reference definitions idempotently', () => {
  const { postprocessMinerUMarkdown } = load();
  const input = 'Text [1], range [1–3], list [4, 5], mixed [2-4, 6], year [2026], and image ![1](figure.png).\n\n## References\n\n[1] First.\n\n[^2]: Existing.\n\n[3] Third.\n\n[4] Fourth.\n\n[5] Fifth.\n\n[6] Sixth.';
  const expected = 'Text [^1], range [^1],[^2],[^3], list [^4],[^5], mixed [^2],[^3],[^4],[^6], year [2026], and image ![1](figure.png).\n\n## References\n\n[^1]: First.\n\n[^2]: Existing.\n\n[^3]: Third.\n\n[^4]: Fourth.\n\n[^5]: Fifth.\n\n[^6]: Sixth.';
  assert.equal(postprocessMinerUMarkdown(input), expected);
  assert.equal(postprocessMinerUMarkdown(expected), expected);
});

test('does not call Agent API when Markdown saving is disabled', async () => {
  const { parsePdfWithMinerU } = load();
  await assert.rejects(
    parsePdfWithMinerU(new ArrayBuffer(1), 'paper.pdf', settings({ mineruSaveMarkdown: false }), () => {}, async () => { throw new Error('must not call'); }, async () => {}),
    /轻量 Agent API 只返回 Markdown/,
  );
});
