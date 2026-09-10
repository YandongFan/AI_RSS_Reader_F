import { Notice, type App, type View } from 'obsidian';
import { bypassEzProxy, proxyUrl } from './ezproxy';
import { normalizeLiteratureSaveFolder } from './literature-input';

interface Webview {
  getURL(): string;
  executeJavaScript(script: string): Promise<unknown>;
}

class ArticleAddressMismatchError extends Error {}

export interface BrowserPage { url: string; html: string; outputFolder?: string; close?: () => void; }

export interface BrowserCaptureOptions {
  automatic?: boolean;
  retryIntervalMs?: number;
  /** Keep the caller's active leaf visible while the capture tab runs. */
  background?: boolean;
  /** Vault-relative root folder shown in the manual capture bar. */
  outputFolder?: string;
}

function articleWebview(view: View): Webview | undefined {
  const embedded = view.containerEl?.querySelector('webview') as (Element & Partial<Webview>) | null;
  for (const candidate of [(view as View & { webview?: Webview }).webview, embedded]) {
    if (candidate && typeof candidate.getURL === 'function' && typeof candidate.executeJavaScript === 'function') return candidate as Webview;
  }
  return undefined;
}

export async function ensureBrowserArticle(app: App, target: string, prefix = '', signal?: AbortSignal, options: BrowserCaptureOptions = {}): Promise<BrowserPage> {
  if (bypassEzProxy(target)) prefix = '';
  if (signal?.aborted) throw new Error('已取消文献采集');
  const browserApp = app as App & {
    internalPlugins?: { getEnabledPluginById(id: string): unknown };
    setting?: { close(): void };
  };
  if (!browserApp.internalPlugins?.getEnabledPluginById('webviewer')) {
    throw new Error('请先在“设置 → 核心插件”中启用“网页浏览器”');
  }
  const leaves = app.workspace.getLeavesOfType('webviewer');
  const url = prefix ? proxyUrl(target, prefix) : target;
  const previousLeaf = app.workspace.activeLeaf;
  const background = options.background === true;
  let leaf = leaves.find((item) => {
    try {
      const current = articleWebview(item.view)?.getURL();
      return current && (current === url || matchesArticle(current, target, prefix));
    } catch { return false; }
  });
  if (!leaf) {
    leaf = app.workspace.getLeaf('tab');
    try { await leaf.setViewState({ type: 'webviewer', active: !background, state: { url, navigate: true } }); }
    catch (error) { leaf.detach(); throw error; }
  }
  if (background) {
    if (previousLeaf && previousLeaf !== leaf) await app.workspace.revealLeaf(previousLeaf);
  } else {
    await app.workspace.revealLeaf(leaf);
  }
  browserApp.setting?.close();
  if (signal?.aborted) throw new Error('已取消文献采集');
  if (!app.workspace.getLeavesOfType('webviewer').includes(leaf)) throw new Error('论文页面已关闭，已取消保存');
  const articleLeaf = leaf;
  const retryIntervalMs = Number.isFinite(options.retryIntervalMs)
    ? Math.min(30000, Math.max(500, options.retryIntervalMs!))
    : 1500;
  return new Promise<BrowserPage>((resolve, reject) => {
    // Keep controls in Obsidian, outside the publisher DOM and captured HTML.
    const container = articleLeaf.view.containerEl;
    const banner = container.ownerDocument.createElement('div');
    banner.className = 'ai-rss-capture-bar';
    const start = banner.appendChild(container.ownerDocument.createElement('button'));
    start.type = 'button';
    start.className = 'mod-cta';
    start.textContent = '开始抓取';
    const cancel = banner.appendChild(container.ownerDocument.createElement('button'));
    cancel.type = 'button';
    cancel.textContent = '取消';
    let folderInput: HTMLInputElement | undefined;
    if (!options.automatic) {
      const folderLabel = banner.appendChild(container.ownerDocument.createElement('label'));
      folderLabel.className = 'ai-rss-capture-folder';
      const folderText = folderLabel.appendChild(container.ownerDocument.createElement('span'));
      folderText.textContent = '保存到';
      folderInput = folderLabel.appendChild(container.ownerDocument.createElement('input'));
      folderInput.type = 'text';
      folderInput.value = options.outputFolder || 'AI RSS Reader';
      folderInput.placeholder = '库内相对路径';
      folderInput.setAttribute('aria-label', '文献保存根目录');
    }
    const status = banner.appendChild(container.ownerDocument.createElement('span'));
    status.setAttribute('role', 'status');
    status.textContent = options.automatic
      ? '批量自动抓取：正在等待论文正文加载完整…'
      : prefix
        ? '等待确认：请完成机构登录，确认正文加载完整后点击“开始抓取”。'
        : '等待确认：请确认正文加载完整后点击“开始抓取”。';
    container.prepend(banner);
    let finished = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let automaticTimeout: ReturnType<typeof setTimeout> | undefined;
    let lastAutomaticError = '';
    let confirmMismatch: HTMLButtonElement | undefined;
    const cleanup = (): void => {
      finished = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (automaticTimeout) clearTimeout(automaticTimeout);
      banner.remove();
      app.workspace.offref(closed);
      signal?.removeEventListener('abort', abort);
    };
    const abort = (): void => {
      if (finished) return;
      cleanup();
      reject(new Error('已取消文献采集，原笔记未修改'));
    };
    const closed = app.workspace.on('layout-change', () => {
      if (!app.workspace.getLeavesOfType('webviewer').includes(articleLeaf)) abort();
    });
    signal?.addEventListener('abort', abort, { once: true });
    cancel.addEventListener('click', abort);
    const offerMismatchOverride = (): void => {
      if (options.automatic || confirmMismatch) return;
      confirmMismatch = container.ownerDocument.createElement('button');
      confirmMismatch.type = 'button';
      confirmMismatch.className = 'mod-warning';
      confirmMismatch.textContent = '确认正确，继续抓取';
      banner.insertBefore(confirmMismatch, cancel);
      confirmMismatch.addEventListener('click', () => capture(false, true));
    };
    const capture = (automatic = false, allowAddressMismatch = false): void => {
      if (finished || start.disabled) return;
      let outputFolder: string | undefined;
      try {
        outputFolder = folderInput ? normalizeLiteratureSaveFolder(folderInput.value) : undefined;
        if (folderInput) folderInput.value = outputFolder!;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        folderInput?.focus();
        new Notice(status.textContent, 8000);
        return;
      }
      start.disabled = true;
      if (folderInput) folderInput.disabled = true;
      start.textContent = automatic ? '自动抓取中…' : '正在读取…';
      if (confirmMismatch) {
        confirmMismatch.disabled = true;
        if (allowAddressMismatch) confirmMismatch.textContent = '正在读取已确认页面…';
      }
      status.textContent = '正在检查并读取当前论文页面…';
      const notice = automatic ? undefined : new Notice('已开始抓取：正在读取论文页面…', 5000);
      void (async () => {
        try {
          // Read this exact tab, not another matching tab with older content.
          const page = await captureArticleView(articleLeaf.view, target, prefix, signal, allowAddressMismatch);
          if (finished) return;
          if (!app.workspace.getLeavesOfType('webviewer').includes(articleLeaf)) { abort(); return; }
          cleanup();
          notice?.hide();
          resolve({ ...page, outputFolder, close: () => articleLeaf.detach() });
        } catch (error) {
          if (finished) return;
          lastAutomaticError = error instanceof Error ? error.message : String(error);
          if (error instanceof ArticleAddressMismatchError) offerMismatchOverride();
          status.textContent = automatic
            ? `批量自动抓取：页面尚未就绪，将继续重试。${lastAutomaticError}`
            : lastAutomaticError;
          notice?.hide();
          if (!automatic) new Notice(status.textContent, 10000);
          start.disabled = false;
          if (folderInput) folderInput.disabled = false;
          start.textContent = automatic ? '立即重试' : '开始抓取';
          if (confirmMismatch) {
            confirmMismatch.disabled = false;
            confirmMismatch.textContent = '确认正确，继续抓取';
          }
          if (automatic) retryTimer = setTimeout(() => capture(true), retryIntervalMs);
        }
      })();
    };
    start.addEventListener('click', () => capture(options.automatic));
    if (options.automatic) {
      retryTimer = setTimeout(() => capture(true), retryIntervalMs);
      automaticTimeout = setTimeout(() => {
        if (finished) return;
        cleanup();
        reject(new Error(`批量自动抓取等待页面就绪超时（60 秒）${lastAutomaticError ? `：${lastAutomaticError}` : ''}`));
      }, 60000);
    }
    if (signal?.aborted) abort();
  });
}

// DOI resolvers and publisher landing pages can represent the same paper.
// Only derive identities from recognized hosts (including their configured
// proxy forms) so an unrelated page containing a DOI-like path cannot match.
function recognizedDoi(url: URL, prefix: string): string {
  let host = url.hostname;
  if (!['https:', 'http:'].includes(url.protocol)) return '';
  if (prefix) {
    const suffix = `.${new URL(prefix.replace('$@', '')).hostname}`;
    if (host.endsWith(suffix)) host = host.slice(0, -suffix.length);
  }
  const hosts: Record<string, string> = {
    'journals-aps-org': 'journals.aps.org', 'link-aps-org': 'link.aps.org',
    'doi-org': 'doi.org', 'dx-doi-org': 'dx.doi.org',
    'www-nature-com': 'www.nature.com', 'nature-com': 'nature.com',
    'www-science-org': 'www.science.org', 'science-org': 'science.org',
  };
  host = hosts[host] ?? host;
  const path = decodeURIComponent(url.pathname);
  const pattern = host === 'journals.aps.org' ? /^\/[a-z]+\/(?:abstract|fulltext)\/(10\.1103\/[^/]+)\/?$/i
    : host === 'link.aps.org' ? /^\/doi\/(10\.1103\/[^/]+)\/?$/i
    : ['www.nature.com', 'nature.com'].includes(host) ? /^\/articles\/([^/]+)\/?$/i
    : ['www.science.org', 'science.org'].includes(host) ? /^\/doi\/(?:abs\/|full\/)?(10\.1126\/[^/]+)\/?$/i
    : ['doi.org', 'dx.doi.org'].includes(host) ? /^\/(10\.\d{4,9}\/[^/]+)\/?$/i : undefined;
  const match = pattern?.exec(path);
  if (!match) return '';
  return ['www.nature.com', 'nature.com'].includes(host)
    ? `10.1038/${match[1]}`.toLowerCase()
    : match[1].toLowerCase();
}

// Publishers without a recognized DOI-bearing URL retain exact path/query matching.
export function matchesArticle(currentUrl: string, targetUrl: string, prefix = ''): boolean {
  try {
    const current = new URL(currentUrl), target = new URL(targetUrl);
    if (!['https:', 'http:'].includes(current.protocol)) return false;
    const targetDoi = recognizedDoi(target, prefix);
    if (targetDoi) return recognizedDoi(current, prefix) === targetDoi;
    const hosts = [target.hostname];
    if (prefix) {
      const proxy = new URL(prefix.replace('$@', ''));
      hosts.push(`${target.hostname.replace(/\./g, '-')}.${proxy.hostname}`, `${target.hostname}.${proxy.hostname}`);
    }
    return hosts.includes(current.hostname) && current.pathname === target.pathname && current.search === target.search;
  } catch { return false; }
}

export async function captureBrowserArticle(app: App, target: string, prefix = ''): Promise<BrowserPage> {
  const leaves = [...app.workspace.getLeavesOfType('webviewer')];
  // Prefer the authenticated proxy tab if the public publisher page is also open.
  const isProxyTab = (view: View): number => {
    try {
      const url = articleWebview(view)?.getURL();
      return url && new URL(url).hostname.endsWith(`.${new URL(prefix.replace('$@', '')).hostname}`) ? 1 : 0;
    } catch { return 0; }
  };
  leaves.sort((a, b) => isProxyTab(b.view) - isProxyTab(a.view));
  for (const leaf of leaves) {
    const webview = articleWebview(leaf.view);
    if (!webview) continue;
    let url: string;
    try { url = webview.getURL(); } catch { continue; }
    if (!matchesArticle(url, target, prefix)) continue;
    return captureArticleView(leaf.view, target, prefix);
  }
  throw new Error('请在 Obsidian 网页浏览器中打开这篇论文，完成机构登录并显示全文后，保持标签打开再保存');
}

async function captureArticleView(view: View, target: string, prefix: string, signal?: AbortSignal, allowAddressMismatch = false): Promise<BrowserPage> {
  const webview = articleWebview(view);
  if (!webview) throw new Error('未找到当前标签的网页控件，请重新打开论文标签后重试');
  const currentUrl = webview.getURL();
  if (!allowAddressMismatch && !matchesArticle(currentUrl, target, prefix)) {
    // Paths identify the article; omit query strings that may contain login tokens.
    const displayUrl = (value: string): string => {
      try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return '无法读取地址'; }
    };
    throw new ArticleAddressMismatchError(`当前标签与目标论文地址不匹配。目标：${displayUrl(target)}；当前：${displayUrl(currentUrl)}。若确认当前页面就是目标文献，可点击“确认正确，继续抓取”`);
  }
  // Validate and snapshot atomically in the page; readyState alone does not
  // mean that the publisher's asynchronous full text has arrived.
  const script = `(() => {
    (${assertArticlePage.toString()})(document);
    (${assertCaptureReady.toString()})(document, location.href);
    return { url: location.href, html: document.documentElement.outerHTML };
  })()`;
  const result = await new Promise<unknown>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new Error('已取消文献采集')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('读取论文页面超时（15 秒），请刷新网页后重试'));
    }, 15000);
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    // Consume late resolutions/rejections after a timeout; they must not save.
    Promise.resolve().then(() => webview.executeJavaScript(script)).then(
      value => { cleanup(); resolve(value); },
      error => { cleanup(); reject(error); },
    );
  });
  if (!result || typeof result !== 'object') throw new Error('无法读取论文页面正文，请刷新文献标签后重试');
  const page = result as Partial<BrowserPage>;
  if (typeof page.url !== 'string' || (!allowAddressMismatch && !matchesArticle(page.url, target, prefix)) ||
      webview.getURL() !== page.url) throw new Error('文献页面正在跳转，请等待加载完成后重试');
  if (typeof page.html !== 'string' || !page.html.trim()) throw new Error('论文页面内容为空');
  return { url: page.url, html: page.html };
}

// Self-contained: also serialized into the browser webview above.
export function assertCaptureReady(doc: Document, url: string): void {
  const host = new URL(url).hostname;
  if (host !== 'journals.aps.org' && !host.startsWith('journals-aps-org.') && !host.startsWith('journals.aps.org.')) {
    if (doc.readyState === 'loading') throw new Error('论文页面仍在加载');
    return;
  }
  const fulltext = doc.querySelector('#fulltext-content')
    ?? doc.querySelector('.article-fulltext-front')
    ?? doc.querySelector('section.article.fulltext');
  if (!fulltext) throw new Error('未找到 APS 全文，请确认当前页面已显示 Article Text');
  // The user explicitly confirms readiness. APS may leave data-loaded=pending
  // while typesetting equations even after inserting the article paragraphs.
  // Check for actual prose, not completion of unrelated resources or MathJax.
  const hasBody = Array.from(fulltext.querySelectorAll('p')).some(paragraph => {
    if (paragraph.closest('.section-load-error, .spinner-container, [role="alert"]')) return false;
    return Array.from(paragraph.childNodes).some(node => {
      if (node.nodeType === 1 && ['SCRIPT', 'STYLE'].includes((node as Element).tagName)) return false;
      return Boolean(node.textContent?.trim());
    });
  });
  if (hasBody) return;
  const state = fulltext.getAttribute('data-loaded');
  if (state === 'error') throw new Error('APS 全文加载失败，请刷新论文页面后重试');
  throw new Error('APS 全文区域尚无正文段落，请确认 Article Text 中已显示论文正文');
}

export function assertArticlePage(doc: Document): void {
  const title = doc.title.trim();
  const text = doc.body?.textContent ?? '';
  const hasMetadata = Boolean(doc.querySelector('meta[name="citation_title"], meta[name="citation_doi"]'));
  if (!hasMetadata && (doc.querySelector('input[type="password"]') ||
      /^(?:SUTD Library|.*(?:sign in|log in|login|access denied|机构登录))$/i.test(title) ||
      /Electronic resources subscribed by SUTD Library|Click.*Library Policy and Guidelines on User of eResources/i.test(text))) {
    throw new Error('当前内容是机构登录或提示页面，未作为论文正文保存；请在浏览器中打开论文全文后重试');
  }
}
