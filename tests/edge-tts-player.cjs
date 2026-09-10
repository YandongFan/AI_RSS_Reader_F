const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const code = buildSync({
  entryPoints: ['src/edge-tts-player.ts'], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['obsidian', 'msedge-tts'],
}).outputFiles[0].text;
class MockTFile {
  constructor(path) {
    this.path = path;
    this.extension = path.split('.').pop();
    this.basename = path.split('/').pop().replace(/\.[^.]+$/, '');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/';
    this.parent = { path: parent };
  }
}

class MockNotice {
  setMessage() {}
  hide() {}
}

const sandbox = {
  module: { exports: {} }, exports: {}, Blob, Buffer,
  require: name => name === 'obsidian'
    ? { Notice: MockNotice, TFile: MockTFile, normalizePath: value => value.replace(/^\/+/, ''), setIcon() {} }
    : name === 'msedge-tts'
      ? { MsEdgeTTS: class {}, OUTPUT_FORMAT: {} }
      : require(name),
};
vm.runInNewContext(code, sandbox);
const api = sandbox.module.exports;

test('turns a rough-reading note into bounded speech segments without markup or formulas', () => {
  const markdown = `---\naudio-tutor: rough-reading\n---\n# 标题\n\n> [!info] Audio Tutor\n> 元信息\n\n这是[论文](https://example.com)的第一段，参见[[Theory|理论]]。\n\n$$E=mc^2$$\n\n\\[a=b\\]\n\n还有 $k=0$。\n\n这是第二段，包含 **物理图像**。`;
  const segments = Array.from(api.markdownToSpeechSegments(markdown, 40));
  assert.ok(segments.length >= 2);
  assert.doesNotMatch(segments.join(' '), /audio-tutor|https|E=mc|a=b|k=0|\*\*|Theory/);
  assert.match(segments.join(' '), /理论/);
  assert.match(segments.join(' '), /物理图像/);
  assert.ok(segments.every(value => value.length <= 40));
});

test('places an exported MP3 beside the Markdown note', () => {
  const file = { basename: 'Theory note', parent: { path: 'Papers/Weyl' } };
  assert.equal(api.markdownMp3Path(file), 'Papers/Weyl/Theory note-EdgeTTS.mp3');
  assert.equal(api.markdownMp3Path({ basename: 'Root note', parent: { path: '/' } }), 'Root note-EdgeTTS.mp3');
});

test('offers gender-labelled Chinese and English voices with a multilingual default', () => {
  const options = Array.from(api.EDGE_TTS_VOICE_OPTIONS);
  const selected = options.find(option => option.value === api.EDGE_TTS_DEFAULT_VOICE);
  assert.equal(selected.group, '中英通用');
  assert.ok(options.some(option => option.group === '中文' && option.gender === '女'));
  assert.ok(options.some(option => option.group === '中文' && option.gender === '男'));
  assert.ok(options.some(option => option.group === '英文' && option.gender === '女'));
  assert.ok(options.some(option => option.group === '英文' && option.gender === '男'));
});

test('shows the Markdown player only in reading mode', () => {
  const file = { extension: 'md' };
  assert.equal(api.shouldShowMarkdownTts({ file, getMode: () => 'preview' }), true);
  assert.equal(api.shouldShowMarkdownTts({ file, getMode: () => 'source' }), false);
  assert.equal(api.shouldShowMarkdownTts({ file: { extension: 'pdf' }, getMode: () => 'preview' }), false);
  assert.equal(api.shouldShowMarkdownTts({ file: null, getMode: () => 'preview' }), false);
});

test('switching notes does not cancel an MP3 export in progress', async () => {
  const file = new MockTFile('Notes/Background export.md');
  let finishSynthesis;
  let synthesisStarted;
  const started = new Promise(resolve => { synthesisStarted = resolve; });
  const created = [];
  const host = {
    app: { vault: {
      cachedRead: async () => 'A paragraph that is long enough to export.',
      getFileByPath: () => null,
      createBinary: async (path, bytes) => { created.push({ path, bytes }); return new MockTFile(path); },
    } },
    settings: () => ({ edgeTtsVoice: 'voice', edgeTtsRate: 0, edgeTtsPitch: 0, edgeTtsVolume: 0 }),
    saveSettings: async () => {},
    position: () => 0,
    savePosition: async () => {},
  };
  const player = new api.MarkdownTtsPlayer(host);
  let exportCancellations = 0;
  player.exportTts.synthesize = async () => {
    synthesisStarted();
    return new Promise(resolve => { finishSynthesis = () => resolve(new Blob([Buffer.from('mp3')])); });
  };
  player.exportTts.cancel = () => { exportCancellations += 1; };

  const exporting = player.exportMp3(file);
  await started;
  player.detach();
  assert.equal(exportCancellations, 0);
  finishSynthesis();
  await exporting;

  assert.equal(created.length, 1);
  assert.equal(created[0].path, 'Notes/Background export-EdgeTTS.mp3');
});
