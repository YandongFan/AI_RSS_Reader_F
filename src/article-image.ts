// Adapted from Academic_RSS_Reader-Obsidian's RSS image rules; see THIRD_PARTY_NOTICES.md.
const DECORATIVE = /\b(?:advertisement|avatar|favicon|icon|logo|pixel|spacer|tracking)\b/i;

export function safeImageUrl(value: string, base?: string): string {
  if (!value.trim()) return '';
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function candidate(node: Element, base: string, assumeImage = false): string {
  const url = safeImageUrl(node.getAttribute('url') || node.getAttribute('href') || node.getAttribute('src') || node.getAttribute('data-src') || '', base);
  if (!url || ['width', 'height'].some(key => Number.parseInt(node.getAttribute(key) ?? '', 10) <= 1)) return '';
  if (DECORATIVE.test([url, ...['alt', 'class', 'id', 'title'].map(key => node.getAttribute(key) ?? '')].join(' '))) return '';
  const type = node.getAttribute('type');
  const medium = node.getAttribute('medium');
  return (assumeImage || (type ? type.startsWith('image/') : medium ? medium === 'image' : /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#]|$)/i.test(url))) ? url : '';
}

export function extractArticleImage(entry: Element, base: string): string {
  const nodes = Array.from(entry.querySelectorAll('*'));
  for (const name of ['content', 'thumbnail', 'enclosure', 'link']) {
    for (const node of nodes.filter(node => node.localName.split(':').pop() === name)) {
      if (name === 'content' && !node.getAttribute('url')) continue;
      if (name === 'link' && node.getAttribute('rel') !== 'enclosure') continue;
      const url = candidate(node, base, name === 'thumbnail');
      if (url) return url;
    }
  }
  for (const node of nodes.filter(node => ['summary', 'description', 'content', 'encoded'].includes(node.localName.split(':').pop() ?? ''))) {
    const doc = new DOMParser().parseFromString(node.textContent ?? '', 'text/html');
    for (const img of [...Array.from(node.querySelectorAll('img')), ...Array.from(doc.querySelectorAll('img'))]) {
      const url = candidate(img, base, true);
      if (url) return url;
    }
  }
  return '';
}
