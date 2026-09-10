export type AttachmentKind = 'supplementary' | 'peer-review';
export interface AttachmentLink { url: string; kind: AttachmentKind; label: string }
export interface SavedAttachment extends AttachmentLink { path: string }

export const SUPPLEMENTARY_FILE_TYPES = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'tar', 'csv', 'tsv', 'txt', 'xml', 'json', 'rtf', 'png', 'jpg', 'jpeg', 'tif', 'tiff', 'mp4', 'mov', 'avi'] as const;

const peerReview = /\b(?:peer[\s_-]*review|review(?:er|ers)?[\s_-]*(?:reports?|comments?|files?|history)|referee[\s_-]*(?:reports?|comments?)|review[\s_-]*process|editorial[\s_-]*(?:decision|history)|decision[\s_-]*letter|author[\s_-]*(?:response|rebuttal)|response[\s_-]*to[\s_-]*(?:reviewers?|referees?))\b|同行评审|审稿意见|审稿报告|作者回复/i;
const supplementary = /\b(?:supporting[\s_-]*(?:information|materials?|data|files?)|supplement(?:al|ary|s)?(?:[\s_-]*(?:information|materials?|data|files?|appendi(?:x|ces)|methods?|tables?|figures?|videos?|movies?|text))?|additional[\s_-]*(?:files?|materials?|information)|electronic[\s_-]*supplementary|appendi(?:x|ces)|source[\s_-]*data)\b|补充材料|补充信息|补充数据|附录|附件/i;
const extensions = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|tsv|txt|xml|json|rtf|gz|tar|mp4|mov|avi|png|jpe?g|tiff?)(?:$|[?#&])/i;

export function attachmentKind(text: string): AttachmentKind | undefined {
  const normalized = text.replace(/[_-]+/g, ' ');
  if (peerReview.test(normalized)) return 'peer-review';
  if (supplementary.test(normalized) || /(?:\/suppl(?:ementary)?\/|\/suppinfo\b|\/suppl_file\/|_esm\b|_moesm\d+\b|[._-]s\d+\.(?:pdf|zip|docx?)\b|[._-]s00\d\b)/i.test(text)) return 'supplementary';
  return undefined;
}

export function findAttachments(doc: Document, baseUrl: string, inherited?: AttachmentKind): AttachmentLink[] {
  const found = new Map<string, AttachmentLink>();
  for (const element of Array.from(doc.querySelectorAll('a[href], link[href]'))) {
    const href = element.getAttribute('href')?.trim();
    if (!href || href.startsWith('#')) continue;
    let url: URL;
    try { url = new URL(href, baseUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    url.hash = '';
    const base = new URL(baseUrl); base.hash = '';
    if (url.href === base.href) continue;
    const label = [element.textContent, element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('download')].filter(Boolean).join(' ').trim();
    let decoded = url.href;
    try { decoded = decodeURIComponent(decoded); } catch { /* Keep malformed escapes as-is. */ }
    let kind = attachmentKind(label) || attachmentKind(decoded);
    // Restrict context to the nearest attachment block, never the entire article.
    if (!kind) {
      let block = element.parentElement;
      for (let level = 0; block && level < 5 && !kind; level++, block = block.parentElement) {
        if (block === doc.body || /^(ARTICLE|MAIN|HTML)$/i.test(block.tagName)) break;
        if (block.querySelectorAll('a[href]').length > 12) break;
        const heading = block.querySelector('h2, h3, h4, h5');
        kind = attachmentKind(heading?.textContent || '') || attachmentKind(`${block.id} ${block.className}`);
        if (!kind && /^(LI|DD|P)$/i.test(block.tagName) && (block.textContent?.length ?? 0) < 500) kind = attachmentKind(block.textContent || '');
      }
    }
    if (!kind && inherited && (extensions.test(decoded) || element.getAttribute('type') === 'application/pdf' || element.hasAttribute('download'))) kind = inherited;
    if (!kind) continue;
    const existing = found.get(url.href);
    if (!existing || kind === 'peer-review') found.set(url.href, { url: url.href, kind, label: label || kind });
  }
  return [...found.values()];
}

export interface AttachmentResponse { arrayBuffer: ArrayBuffer; headers: Record<string, string> }
function header(response: AttachmentResponse, key: string): string {
  return Object.entries(response.headers).find(([name]) => name.toLowerCase() === key)?.[1] || '';
}

export function isHtmlAttachment(response: AttachmentResponse): boolean {
  const start = new TextDecoder().decode(response.arrayBuffer.slice(0, 1024)).trimStart();
  return /(?:text\/html|application\/xhtml)/i.test(header(response, 'content-type')) || /^(?:<!doctype\s+html|<html|<head|<body|<!--)/i.test(start);
}

export function attachmentExtension(response: AttachmentResponse, url: string): string {
  const bytes = new Uint8Array(response.arrayBuffer);
  if (!bytes.length) throw new Error('附件内容为空');
  if (isHtmlAttachment(response)) throw new Error('返回了网页，可能需要登录或点击下载');
  const signature = new TextDecoder().decode(bytes.slice(0, 5));
  if (signature === '%PDF-') return 'pdf';
  const disposition = header(response, 'content-disposition');
  let filename = disposition.match(/filename\*?\s*=\s*(?:UTF-8'')?"?([^";\r\n]+)/i)?.[1] || '';
  try { filename = decodeURIComponent(filename); } catch { /* Keep undecodable filename. */ }
  const ext = (filename.match(extensions)?.[1] || url.match(extensions)?.[1] || '').toLowerCase();
  if (ext === 'pdf' || /application\/pdf/i.test(header(response, 'content-type'))) throw new Error('下载结果不是 PDF');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip) return ['docx', 'xlsx', 'pptx'].includes(ext) ? ext : 'zip';
  if (['zip', 'docx', 'xlsx', 'pptx'].includes(ext)) throw new Error('附件格式与文件扩展名不符');
  if (ext) return ext;
  const mime = header(response, 'content-type').split(';')[0].trim().toLowerCase();
  const types: Record<string, string> = { 'text/plain': 'txt', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls', 'application/json': 'json', 'application/xml': 'xml', 'video/mp4': 'mp4', 'application/gzip': 'gz' };
  if (types[mime]) return types[mime];
  throw new Error('无法识别附件格式');
}

export async function downloadAttachments(
  links: AttachmentLink[], enabled: (kind: AttachmentKind) => boolean,
  fetch: (url: string) => Promise<AttachmentResponse>,
  save: (file: AttachmentLink, extension: string, data: ArrayBuffer, index: number) => Promise<string>,
  parse: (html: string) => Document,
  supplementaryFileTypes: readonly string[] = SUPPLEMENTARY_FILE_TYPES,
  peerReviewFileTypes: readonly string[] = SUPPLEMENTARY_FILE_TYPES,
): Promise<{ files: SavedAttachment[]; warnings: string[] }> {
  const files: SavedAttachment[] = [];
  const warnings: string[] = [];
  const visited = new Set<string>();
  const queue = links.filter(link => enabled(link.kind)).map(link => ({ link, depth: 0 }));
  for (let i = 0; i < queue.length; i++) {
    const { link, depth } = queue[i];
    const selectedTypes = link.kind === 'supplementary' ? supplementaryFileTypes : peerReviewFileTypes;
    if (!selectedTypes.length) continue;
    {
      // Skip known unwanted files before making a request. Extensionless
      // endpoints and landing pages still need fetching to determine their type.
      let decoded = link.url;
      try { decoded = decodeURIComponent(decoded); } catch { /* Keep malformed escapes. */ }
      const hintedExtension = decoded.match(extensions)?.[1].toLowerCase();
      if (hintedExtension && !selectedTypes.includes(hintedExtension)) continue;
    }
    if (visited.has(link.url)) continue;
    if (visited.size >= 100) { warnings.push('附件超过 100 个请求，剩余附件未下载'); break; }
    visited.add(link.url);
    try {
      const response = await fetch(link.url);
      if (isHtmlAttachment(response)) {
        if (depth > 0) throw new Error('附件链接返回网页，可能需要登录或手动下载');
        const children = findAttachments(parse(new TextDecoder().decode(response.arrayBuffer)), link.url, link.kind)
          .filter(child => enabled(child.kind) && !visited.has(child.url));
        if (!children.length) throw new Error('附件页面未发现可下载文件，可能需要登录或手动下载');
        queue.push(...children.map(child => ({ link: child, depth: depth + 1 })));
        continue;
      }
      const ext = attachmentExtension(response, link.url);
      if (!selectedTypes.includes(ext)) continue;
      const path = await save(link, ext, response.arrayBuffer, files.length + 1);
      files.push({ ...link, path });
    } catch (error) {
      warnings.push(`${link.kind === 'peer-review' ? '同行评审' : '补充材料'}下载失败（${link.url}）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { files, warnings };
}
