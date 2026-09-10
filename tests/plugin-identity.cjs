const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');

test('F edition has its own manifest identity and view registrations', () => {
  const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.id, 'ai-rss-reader-f');
  assert.equal(manifest.name, 'AI RSS Reader F');
  assert.match(readFileSync('src/view.ts', 'utf8'), /AI_RSS_VIEW = 'ai-rss-reader-f-view'/);
  assert.match(readFileSync('src/audio-tutor-view.ts', 'utf8'), /AUDIO_TUTOR_DERIVATION_VIEW = 'ai-rss-f-audio-tutor-derivation'/);
  assert.match(readFileSync('README.md', 'utf8'), /plugins\/ai-rss-reader-f\//);
});
