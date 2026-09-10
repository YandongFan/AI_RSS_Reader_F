import Defuddle from 'defuddle';
import { attachmentKind, downloadAttachments, findAttachments, type SavedAttachment } from './attachments';
import { cleanArticle } from './cleaning';
import { captureBrowserArticle, assertArticlePage, type BrowserPage } from './browser-page';
import { proxyUrl, isProxyHost, readProxyCookies } from './ezproxy';
import { App, TFile, normalizePath, requestUrl } from 'obsidian';
import type { AiRssSettings, RssArticle } from './types';
import { buildYamlProperties, renderNoteTemplate, type TemplateContext } from './template';

export interface LiteratureMetadata {
  title: string;
  authors: string[];
  year: string;
  journal: string;
  doi: string;
  citeKey: string;
  published: string;
}

export interface LiteratureSaveResult {
  markdownPath: string;
  bibPath?: string;
  pdfPath?: string;
  attachments: SavedAttachment[];
  warnings: string[];
}

interface PageExtraction {
  document: Document;
  markdown: string;
  metadata: LiteratureMetadata;
}

export async function saveLiteraturePackage(app: App, article: RssArticle, settings: AiRssSettings, page?: BrowserPage, onProgress?: (message: string) => void): Promise<LiteratureSaveResult> {
  const warnings: string[] = [];
  let extraction: PageExtraction | undefined;
  try {
    extraction = await extractPage(app, article, settings, warnings, page);
  } catch (error) {
    warnings.push(`正文提取失败：${errorMessage(error)}`);
  }

  let metadata = extraction?.metadata ?? fallbackMetadata(article);
  let bibtex = '';
  if (settings.downloadBibtex) {
    onProgress?.('正在获取 BibTeX');
    try {
      bibtex = await fetchBibtex(metadata, article, extraction?.document);
      if (bibtex) metadata = refineMetadataFromBibtex(metadata, bibtex);
    } catch (error) {
      warnings.push(`BibTeX 下载失败：${errorMessage(error)}`);
    }
    if (!bibtex) {
      bibtex = generateBibtex(metadata, article.link);
      warnings.push('未发现出版社 BibTeX，已根据页面元数据生成 .bib');
    }
  }

  const folderName = renderFolderTemplate(settings.literatureFolderTemplate, metadata);
  let sourceFolder = safeSegment(safeSegment(article.source || '').slice(0, 80)) || '未命名 RSS';
  // Windows device names cannot be used as directory names, even with extensions.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sourceFolder)) sourceFolder = `_${sourceFolder}`;
  const folder = normalizePath(`${settings.outputFolder.trim() || 'AI RSS Reader'}/${sourceFolder}/${folderName}`);
  await ensureFolder(app, folder);
  const baseName = safeSegment(metadata.citeKey || `${firstAuthorSurname(metadata.authors)}-${metadata.year}`) || 'reference';
  const noteName = safeSegment(renderNoteTemplate(settings.noteNameFormat, createTemplateContext(article, metadata))) || baseName;
  const markdownPath = normalizePath(`${folder}/${noteName.slice(0, 160)}.md`);
  const bibPath = settings.downloadBibtex ? normalizePath(`${folder}/${baseName}.bib`) : undefined;
  const pdfPath = settings.downloadPdf ? normalizePath(`${folder}/${baseName}.pdf`) : undefined;

  let savedPdfPath: string | undefined;
  if (pdfPath) {
    onProgress?.('正在下载 PDF');
    try {
      const pdf = await downloadPdf(app, findPdfUrls(article, extraction?.document), settings);
      await app.vault.adapter.writeBinary(pdfPath, pdf);
      savedPdfPath = pdfPath;
    } catch (error) {
      warnings.push(`PDF 下载失败：${errorMessage(error)}`);
    }
  }

  let attachments: SavedAttachment[] = [];
  if (settings.downloadSupplementary || settings.downloadPeerReview) {
    onProgress?.('正在查找和下载附件');
    if (extraction?.document) {
      const result = await downloadAttachments(
        findAttachments(extraction.document, extraction.document.querySelector('base')?.href || article.link),
        kind => kind === 'supplementary' ? settings.downloadSupplementary : settings.downloadPeerReview,
        async url => {
          const accessUrl = settings.ezProxyEnabled ? proxyUrl(url, settings.ezProxyPrefix) : url;
          const response = await requestUrl({ url: accessUrl, method: 'GET', headers: await requestHeaders(app, settings, accessUrl), throw: false });
          if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
          return response;
        },
        async (file, ext, data, index) => {
          const path = normalizePath(`${folder}/${baseName}-${file.kind}-${index}.${ext}`);
          await app.vault.adapter.writeBinary(path, data);
          return path;
        },
        html => new DOMParser().parseFromString(html, 'text/html'),
        settings.supplementaryFileTypes,
        settings.peerReviewFileTypes,
      );
      attachments = result.files;
      warnings.push(...result.warnings);
    } else warnings.push('未能获取文献页面，无法查找补充材料和同行评审文件');
  }
  onProgress?.('正在保存笔记');
  if (bibPath && bibtex) await writeText(app, bibPath, bibtex.trimEnd() + '\n');
  const markdown = buildMarkdown(article, metadata, extraction?.markdown, bibPath, savedPdfPath, warnings, settings, attachments);
  await writeText(app, markdownPath, markdown);
  return { markdownPath, bibPath: bibPath && bibtex ? bibPath : undefined, pdfPath: savedPdfPath, attachments, warnings };
}

async function extractPage(app: App, article: RssArticle, settings: AiRssSettings, warnings: string[], capturedPage?: BrowserPage): Promise<PageExtraction> {
  if (!settings.extractFullText && !settings.downloadPdf && !settings.downloadSupplementary && !settings.downloadPeerReview) return { document: document.implementation.createHTMLDocument(), markdown: article.summary, metadata: fallbackMetadata(article) };
  const page = capturedPage ?? (settings.ezProxyEnabled
    ? await captureBrowserArticle(app, article.link, settings.ezProxyPrefix)
    : { html: await fetchText(app, article.link, settings), url: article.link });
  const { html } = page;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  assertArticlePage(doc);
  // Resolve relative images and attachments against the page actually captured.
  const base = doc.createElement('base');
  base.href = page.url;
  doc.querySelectorAll('base').forEach((element) => element.remove());
  doc.head.prepend(base);
  doc.querySelectorAll('[href], [src]').forEach((element) => {
    for (const attribute of ['href', 'src']) {
      const value = element.getAttribute(attribute);
      if (value && !value.startsWith('#')) {
        try { element.setAttribute(attribute, new URL(value, page.url).href); } catch { /* Keep invalid URLs unchanged. */ }
      }
    }
  });
  if (!settings.extractFullText) return { document: doc, markdown: article.summary, metadata: fallbackMetadata(article) };
  const citationAuthors = metaValues(doc, 'citation_author');
  const citationTitle = metaValue(doc, 'citation_title');
  const citationDate = metaValue(doc, 'citation_publication_date') || metaValue(doc, 'article:published_time');
  const citationJournal = metaValue(doc, 'citation_journal_title') || metaValue(doc, 'prism.publicationname');
  const citationDoi = metaValue(doc, 'citation_doi') || metaValue(doc, 'dc.identifier');
  const parsed = new Defuddle(doc.cloneNode(true) as Document, { url: page.url, useAsync: false }).parse();
  const title = citationTitle || parsed.title || article.title;
  const authors = citationAuthors.length > 0 ? citationAuthors : splitAuthors(parsed.author);
  const published = citationDate || parsed.published || article.published;
  const journal = citationJournal || parsed.site || article.source;
  const doi = normalizeDoi(citationDoi) || doiFromText(article.link) || doiFromText(html);
  const metadata = completeMetadata({ title, authors, year: yearFromDate(published), journal, doi, citeKey: '', published }, article);
  const markdown = await cleanArticle(app.vault.adapter, article.source, doc, page.url, article.link, warnings);
  return { document: doc, markdown, metadata };
}

async function fetchText(app: App, url: string, settings: AiRssSettings): Promise<string> {
  const accessUrl = settings.ezProxyEnabled ? proxyUrl(url, settings.ezProxyPrefix) : url;
  const response = await requestUrl({ url: accessUrl, method: 'GET', headers: await requestHeaders(app, settings, accessUrl), throw: false });
  if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
  if (!response.text.trim()) throw new Error('页面内容为空');
  return response.text;
}

export async function downloadPdf(app: App, urls: string[], settings: AiRssSettings): Promise<ArrayBuffer> {
  if (!urls.length) throw new Error('页面未提供 PDF 地址');
  const attempted = new Set<string>();
  const failures: string[] = [];
  const candidates = [...urls];
  for (let index = 0; index < candidates.length; index++) {
    const url = candidates[index];
    const accessUrl = settings.ezProxyEnabled ? proxyUrl(url, settings.ezProxyPrefix) : url;
    if (attempted.has(accessUrl)) continue;
    attempted.add(accessUrl);
    try {
      const response = await requestUrl({ url: accessUrl, method: 'GET', headers: await requestHeaders(app, settings, accessUrl), throw: false });
      if (response.status >= 400) throw new Error(`HTTP ${response.status}`);
      if (new TextDecoder().decode(response.arrayBuffer.slice(0, 5)) === '%PDF-') return response.arrayBuffer;
      const type = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] || '未知类型';
      const html = new TextDecoder().decode(response.arrayBuffer.slice(0, 262144));
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Wiley's PDF endpoint can return a reader wrapper. Follow only its
      // same-origin pdfdirect source for the exact DOI being downloaded.
      const requested = new URL(accessUrl);
      const doi = requested.pathname.match(/^\/doi\/(?:pdf|epdf)\/(10\..+)$/i)?.[1];
      const source = Array.from(doc.querySelectorAll('script')).map(script =>
        script.textContent?.match(/\bvar\s+src\s*=\s*["'](\/doi\/pdfdirect\/[^"']+)["']/)?.[1],
      ).find(value => value && doi && value === `/doi/pdfdirect/${doi}`);
      if (source) {
        const direct = new URL(source, requested.origin).href;
        if (!attempted.has(direct) && !candidates.includes(direct)) {
          candidates.splice(index + 1, 0, direct);
          continue;
        }
      }
      const login = doc.querySelector('input[type="password"], form[action*="login"], form[action*="signin"]');
      const verification = /just a moment|access denied|cf-chl|verify you are human/i.test(html);
      const reason = login ? '返回了登录页面，请在论文标签页确认机构登录状态' : verification ? '返回了网站验证或访问限制页面' : '下载结果不是 PDF';
      throw new Error(`${reason}（HTTP ${response.status}，${type}）`);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }
  throw new Error(`已尝试 ${attempted.size} 个地址：${[...new Set(failures)].join('；')}`);
}

async function fetchBibtex(metadata: LiteratureMetadata, article: RssArticle, doc?: Document): Promise<string> {
  const embedded = metaValue(doc, 'citation_bibtex');
  if (embedded.startsWith('@')) return embedded;
  const linked = doc ? Array.from(doc.querySelectorAll('link, a')).find((element) => {
    const type = element.getAttribute('type')?.toLowerCase() ?? '';
    const href = element.getAttribute('href')?.toLowerCase() ?? '';
    return type.includes('bibtex') || href.endsWith('.bib') || href.includes('format=bibtex');
  })?.getAttribute('href') : undefined;
  if (linked) {
    const response = await requestUrl({ url: new URL(linked, article.link).href, method: 'GET', throw: false });
    if (response.status < 400 && response.text.trim().startsWith('@')) return response.text;
  }
  if (metadata.doi) {
    const response = await requestUrl({
      url: `https://doi.org/${encodeURIComponent(metadata.doi)}`,
      method: 'GET',
      headers: { Accept: 'application/x-bibtex; charset=utf-8' },
      throw: false,
    });
    if (response.status < 400 && response.text.trim().startsWith('@')) return response.text;
  }
  return '';
}

export function findPdfUrls(article: RssArticle, doc?: Document): string[] {
  const base = doc?.querySelector('base')?.getAttribute('href') || article.link;
  const urls: string[] = [];
  const add = (value: string): void => {
    if (!value) return;
    try {
      const url = new URL(value, base);
      if (!['https:', 'http:'].includes(url.protocol)) return;
      url.hash = '';
      if (!urls.includes(url.href)) urls.push(url.href);
    } catch { /* Ignore malformed candidates without losing other PDF links. */ }
  };
  if (doc) {
    const attachmentUrls = new Set(findAttachments(doc, base).map(file => file.url));
    const elements = Array.from(doc.querySelectorAll('a, link')).filter((candidate) => {
      const href = candidate.getAttribute('href')?.toLowerCase() ?? '';
      const type = candidate.getAttribute('type')?.toLowerCase() ?? '';
      if (attachmentKind(`${candidate.textContent || ''} ${href}`)) return false;
      try { const url = new URL(candidate.getAttribute('href') || '', base); url.hash = ''; if (attachmentUrls.has(url.href)) return false; } catch { return false; }
      return type === 'application/pdf' || /\.pdf(?:$|[?#])/.test(href) || href.includes('/pdf/');
    });
    // Prefer the publisher's in-page link, retaining its authenticated proxy host.
    const rank = (element: Element): number => {
      try {
        const originRank = new URL(element.getAttribute('href') || '', base).origin === new URL(base).origin ? 0 : 2;
        return originRank + (element.tagName.toLowerCase() === 'a' ? 0 : 1);
      } catch { return 4; }
    };
    elements.sort((a, b) => rank(a) - rank(b)).forEach(element => add(element.getAttribute('href') || ''));
  }
  add(metaValue(doc, 'citation_pdf_url'));
  const arxiv = article.link.match(/arxiv\.org\/abs\/([^?#/]+)/i);
  if (arxiv) add(`https://arxiv.org/pdf/${arxiv[1]}.pdf`);
  return urls;
}

async function requestHeaders(app: App, settings: AiRssSettings, accessUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' };
  if (settings.ezProxyEnabled && isProxyUrl(accessUrl, settings.ezProxyPrefix)) {
    const cookies = await readProxyCookies(app, settings.ezProxyPrefix, accessUrl);
    if (cookies) headers.Cookie = cookies;
  }
  return headers;
}

function isProxyUrl(value: string, prefix: string): boolean {
  const host = proxyHostname(prefix);
  try { return Boolean(host && isProxyHost(new URL(value).hostname, host)); } catch { return false; }
}

function proxyHostname(prefix: string): string {
  try { return new URL(prefix.replace('$@', '')).hostname; } catch { return ''; }
}

function fallbackMetadata(article: RssArticle): LiteratureMetadata {
  return completeMetadata({
    title: article.title,
    authors: [],
    year: yearFromDate(article.published),
    journal: article.source,
    doi: doiFromText(article.link),
    citeKey: '',
    published: article.published,
  }, article);
}

function completeMetadata(metadata: LiteratureMetadata, article: RssArticle): LiteratureMetadata {
  const author = firstAuthorSurname(metadata.authors) || 'Unknown';
  const year = metadata.year || yearFromDate(article.published) || 'n.d.';
  const titleWord = metadata.title.split(/\s+/).map((word) => word.replace(/[^\p{L}\p{N}]/gu, '')).find((word) => word.length > 3) || 'work';
  return { ...metadata, year, citeKey: safeSegment(`${author}${year}${titleWord}`).replace(/\s/g, '') };
}

function refineMetadataFromBibtex(metadata: LiteratureMetadata, bibtex: string): LiteratureMetadata {
  const field = (name: string): string => bibtex.match(new RegExp(`${name}\\s*=\\s*[{"]([^}"]+)`, 'i'))?.[1]?.trim() ?? '';
  const authorField = field('author');
  const refined = {
    ...metadata,
    authors: authorField ? authorField.split(/\s+and\s+/i).map((value) => value.trim()) : metadata.authors,
    year: field('year') || metadata.year,
    journal: field('journal') || field('booktitle') || metadata.journal,
    doi: normalizeDoi(field('doi')) || metadata.doi,
  };
  return completeMetadata(refined, { title: metadata.title, published: metadata.published } as RssArticle);
}

function renderFolderTemplate(template: string, metadata: LiteratureMetadata): string {
  const values: Record<string, string> = {
    author: firstAuthorSurname(metadata.authors) || 'Unknown',
    authors: metadata.authors.join(', ') || 'Unknown',
    year: metadata.year || 'n.d.',
    journal: metadata.journal || 'Unknown journal',
    title: metadata.title || 'Untitled',
    citekey: metadata.citeKey,
    doi: metadata.doi || 'no-doi',
  };
  const rendered = template.replace(/\{(author|authors|year|journal|title|citekey|doi)\}/gi, (_match, key: string) => values[key.toLowerCase()] ?? '');
  return safeSegment(rendered).slice(0, 180) || metadata.citeKey || 'reference';
}

function buildMarkdown(article: RssArticle, metadata: LiteratureMetadata, fullText: string | undefined, bibPath: string | undefined, pdfPath: string | undefined, warnings: string[], settings: AiRssSettings, attachments: SavedAttachment[] = []): string {
  const context = createTemplateContext(article, metadata, fullText, bibPath, pdfPath, warnings, attachments);
  const properties = buildYamlProperties(settings.noteProperties, context);
  let body = renderNoteTemplate(settings.noteContentFormat, context).trim();
  if (attachments.length && !/{{\s*(?:filesSection|files|attachmentsSection|attachmentfiles)\b/.test(settings.noteContentFormat)) body += `\n\n${String(context.attachmentsSection)}`;
  if (warnings.length > 0 && !settings.noteContentFormat.includes('{{warningsSection}}')) body += `\n\n${String(context.warningsSection)}`;
  return `---\n${properties}\n---\n\n${body}\n`;
}

function createTemplateContext(article: RssArticle, metadata: LiteratureMetadata, fullText?: string, bibPath?: string, pdfPath?: string, warnings: string[] = [], attachments: SavedAttachment[] = []): TemplateContext {
  const aiAnalysis = Object.entries(article.analysis).map(([profile, result]) => `### ${profile}\n\n${result.relevant ? '匹配' : '不匹配'}：${result.reason}`).join('\n\n') || '暂无分析结果';
  const files = [bibPath ? `- BibTeX：[[${bibPath.split('/').pop()}]]` : '', pdfPath ? `- PDF：[[${pdfPath.split('/').pop()}]]` : ''].filter(Boolean);
  const attachmentLines = attachments.map(file => `- ${file.kind === 'supplementary' ? '补充材料' : '同行评审'}：[[${file.path.split('/').pop()}]]`);
  files.push(...attachmentLines);
  const warningsSection = warnings.length ? `> [!warning] 采集提示\n${warnings.map((warning) => `> - ${warning}`).join('\n')}` : '';
  return {
    title: metadata.title,
    url: article.link,
    source: article.source,
    author: metadata.authors.join(', '),
    authors: metadata.authors,
    published: metadata.published,
    date: localDate(),
    description: article.summary,
    journal: metadata.journal,
    year: metadata.year,
    doi: metadata.doi,
    doiLink: metadata.doi ? ` · [DOI](https://doi.org/${metadata.doi})` : '',
    citekey: metadata.citeKey,
    profiles: article.matchedProfiles,
    content: fullText?.trim() || article.summary || '未能提取正文。',
    aiAnalysis,
    bibfile: bibPath?.split('/').pop() ?? '',
    pdffile: pdfPath?.split('/').pop() ?? '',
    attachmentfiles: attachments.map(file => file.path.split('/').pop() || ''),
    attachmentsSection: attachmentLines.length ? `## 附件\n\n${attachmentLines.join('\n')}\n` : '',
    files: files.join(', '),
    filesSection: files.length ? `## 文件\n\n${files.join('\n')}\n` : '',
    warnings: warnings,
    warningsSection,
  };
}

function generateBibtex(metadata: LiteratureMetadata, url: string): string {
  const escape = (value: string): string => value.replace(/[{}]/g, '').replace(/&/g, '\\&');
  const fields = [
    `  title = {${escape(metadata.title)}}`,
    metadata.authors.length ? `  author = {${metadata.authors.map(escape).join(' and ')}}` : '',
    metadata.journal ? `  journal = {${escape(metadata.journal)}}` : '',
    metadata.year && metadata.year !== 'n.d.' ? `  year = {${metadata.year}}` : '',
    metadata.doi ? `  doi = {${metadata.doi}}` : '',
    `  url = {${url}}`,
  ].filter(Boolean);
  return `@article{${metadata.citeKey},\n${fields.join(',\n')}\n}`;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const parts = normalizePath(path).split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

async function writeText(app: App, path: string, content: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await app.vault.modify(existing, content);
  else await app.vault.create(path, content);
}

function metaValues(doc: Document | undefined, key: string): string[] {
  if (!doc) return [];
  const normalized = key.toLowerCase();
  return Array.from(doc.querySelectorAll('meta')).filter((item) =>
    item.getAttribute('name')?.toLowerCase() === normalized || item.getAttribute('property')?.toLowerCase() === normalized,
  ).map((item) => item.getAttribute('content')?.trim() ?? '').filter(Boolean);
}
function metaValue(doc: Document | undefined, key: string): string { return metaValues(doc, key)[0] ?? ''; }
function splitAuthors(value: string): string[] { return value ? value.split(/\s*(?:,|;|\band\b)\s*/i).filter(Boolean) : []; }
function firstAuthorSurname(authors: string[]): string {
  const author = authors[0]?.trim() ?? '';
  if (!author) return '';
  if (author.includes(',')) return author.split(',')[0].trim();
  return author.split(/\s+/).pop() ?? '';
}
function yearFromDate(value: string): string { return value.match(/(?:19|20)\d{2}/)?.[0] ?? ''; }
function localDate(): string {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
export function normalizeDoi(value: string): string {
  const normalized = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim();
  return /^10\.\d{4,9}\/\S+$/i.test(normalized) ? normalized : '';
}
function doiFromText(value: string): string { return normalizeDoi(value.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i)?.[0] ?? ''); }
function safeSegment(value: string): string { return value.replace(/[\\/:*?"<>|#\[\]^]/g, '-').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
