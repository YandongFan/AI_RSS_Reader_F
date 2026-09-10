const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/audio-tutor.ts'], bundle: true, write: false, platform: 'node', format: 'cjs',
  external: ['obsidian', './ai', './audio-tutor-prompts', './audio-tutor-source'],
}).outputFiles[0].text;
class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split('/').pop();
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.includes('.') ? this.name.split('.').pop() : '';
    this.parent = { path: path.split('/').slice(0, -1).join('/') };
  }
}
const sourceApi = { formulaIndexMarkdown: formulas => formulas.map(item => item.latex).join('\n') };
const promptApi = {};
const aiApi = {};
const sandbox = {
  module: { exports: {} }, exports: {}, Buffer,
  require: name => name === 'obsidian'
    ? { App: class {}, TFile, normalizePath: value => value }
    : name.includes('audio-tutor-source')
      ? sourceApi
      : name.includes('audio-tutor-prompts')
        ? promptApi
        : name.endsWith('/ai') || name === './ai'
          ? aiApi
          : require(name),
};
vm.runInNewContext(code, sandbox);
const api = sandbox.module.exports;

test('rejects display math in rough-reading output', () => {
  assert.equal(api.containsDisplayMath('只讲物理图像，不写公式。'), false);
  assert.equal(api.containsDisplayMath('结果是 $$E=mc^2$$。'), true);
  assert.equal(api.containsDisplayMath('结果是 $E=mc^2$。'), true);
  assert.equal(api.containsDisplayMath('结果是 \\[E=mc^2\\]。'), true);
});

test('clips oversized model context while preserving both ends', () => {
  const clipped = api.clipSource(`BEGIN${'x'.repeat(300)}END`, 120);
  assert.match(clipped, /^BEGIN/);
  assert.match(clipped, /END$/);
  assert.match(clipped, /插件截断/);
});

test('appends parsed supplementary Markdown, layout, content list, and formulas to the prompt', () => {
  const source = {
    pdfFile: { name: 'Paper-supplementary-1.pdf' },
    markdown: '# Supplemental methods\nExtra calibration details.',
    contentListText: '[{"type":"text"}]',
    layoutText: '{"page":1}',
    formulas: [{ latex: 'S(q)=q^2' }],
  };
  const prompt = api.appendSupplementaryContext('MAIN PAPER', [source]);
  assert.match(prompt, /^MAIN PAPER/);
  assert.match(prompt, /Paper-supplementary-1\.pdf/);
  assert.match(prompt, /Extra calibration details/);
  assert.match(prompt, /"type":"text"/);
  assert.match(prompt, /"page":1/);
  assert.match(prompt, /S\(q\)=q\^2/);
  assert.match(prompt, /不得把补充材料独有的结论误写成主文结论/);
});

test('leaves prompts unchanged when a paper has no supplementary PDFs', () => {
  assert.equal(api.appendSupplementaryContext('MAIN PAPER', []), 'MAIN PAPER');
});

test('parses an incomplete supplementary PDF before generating a learning note', async () => {
  const mainPdf = new TFile('Papers/Paper.pdf');
  const supplementPdf = new TFile('Papers/Paper-supplementary-1.pdf');
  const makeSource = (pdf, markdown) => ({
    pdfFile: pdf,
    markdownFile: new TFile(`Papers/Miner_U/${pdf.basename}_MinerU.md`),
    contentListFile: new TFile(`Papers/Miner_U/${pdf.basename}_MinerU_content_list.json`),
    layoutFile: new TFile(`Papers/Miner_U/${pdf.basename}_MinerU_layout.json`),
    folder: 'Papers/Miner_U', base: `${pdf.basename}_MinerU`, paperName: pdf.basename,
    markdown, contentListText: '[]', layoutText: '{}', formulas: [], imagePaths: [],
  });
  const mainSource = makeSource(mainPdf, '# Main paper');
  const supplementSource = makeSource(supplementPdf, '# Supplementary methods');
  let supplementParsed = false;
  const processed = [];
  const writes = new Map();
  let generatedPrompt = '';
  sourceApi.findSupplementaryPdfs = () => [supplementPdf];
  sourceApi.inspectMinerUSource = async input => input === mainPdf
    ? { ...mainSource, missing: [] }
    : { ...supplementSource, missing: supplementParsed ? [] : ['MinerU Markdown', 'content_list JSON', 'layout JSON'] };
  sourceApi.loadMinerUTutorSource = async (_app, input) => {
    if (input === supplementPdf && !supplementParsed) throw new Error('supplement was not parsed');
    return input === mainPdf ? mainSource : supplementSource;
  };
  promptApi.readAudioTutorPrompt = async () => 'MAIN PROMPT';
  aiApi.generateText = async (_provider, prompt) => { generatedPrompt = prompt; return 'Generated note'; };
  const host = {
    app: { vault: {
      getAbstractFileByPath: () => null,
      cachedRead: async () => '',
      create: async (path, body) => ({ path, body }),
      createFolder: async () => undefined,
      adapter: {
        exists: async path => path.endsWith('_Tutor'),
        read: async () => '{}',
        write: async (path, value) => { writes.set(path, value); },
      },
    } },
    state: { settings: {
      mineruToken: 'token', provider: {}, audioTutorLanguage: '中文',
      audioTutorLearnerBackground: 'physics', audioTutorTargetMinutes: 25,
    } },
    saveState: async () => undefined,
    processPdfWithMinerU: async (pdf, overrides) => {
      processed.push({ pdf, overrides });
      supplementParsed = true;
      return [];
    },
  };

  const note = await new api.AudioTutorController(host).generateNote(mainPdf, 'formula-guide');

  assert.equal(processed.length, 1);
  assert.equal(processed[0].pdf, supplementPdf);
  assert.equal(processed[0].overrides.mineruSaveLayoutJson, true);
  assert.match(generatedPrompt, /Supplementary methods/);
  assert.match(note.body, /supplementary-pdfs:[\s\S]*Paper-supplementary-1\.pdf/);
  assert.match([...writes.values()][0], /"supplementarySources"/);
});
