import { App, Notice, View } from 'obsidian';

interface BrowserApp extends App {
  getWebviewPartition?: () => string;
  internalPlugins?: { getEnabledPluginById(id: string): unknown };
  setting?: { close(): void };
}

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  hostOnly?: boolean;
}

interface BrowserSession {
  cookies: {
    get(filter: { domain?: string; url?: string }): Promise<Cookie[]>;
    remove(url: string, name: string): Promise<void>;
  };
}

// Obsidian's renderer exposes main-process APIs through electron.remote.
// Web Viewer and getWebviewPartition are internal APIs; check them before use.
function browserSession(app: BrowserApp): BrowserSession {
  const partition = app.getWebviewPartition?.();
  if (!partition) throw new Error('当前 Obsidian 不支持网页浏览器会话，请升级桌面版');
  const electron = require('electron') as { remote?: { session?: { fromPartition(name: string): BrowserSession } } };
  const session = electron.remote?.session;
  if (!session?.fromPartition) throw new Error('无法访问 Obsidian 网页浏览器会话，请重启或升级 Obsidian 桌面版');
  return session.fromPartition(partition);
}

export function bypassEzProxy(target: string): boolean {
  try {
    const url = new URL(target);
    return ['http:', 'https:'].includes(url.protocol) &&
      (url.hostname === 'arxiv.org' || url.hostname.endsWith('.arxiv.org') ||
        (url.hostname === 'doi.org' && /^\/10\.48550\/arxiv\./i.test(url.pathname)));
  } catch { return false; }
}

export function proxyUrl(target: string, prefix: string): string {
  if (bypassEzProxy(target)) return target;
  const template = prefix.trim();
  let base: URL;
  try { base = new URL(template.replace('$@', '')); } catch { throw new Error('EZProxy 地址格式无效'); }
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('EZProxy 地址必须是 HTTP 或 HTTPS 地址，且不能包含账号密码');
  const destination = new URL(target);
  if (!['https:', 'http:'].includes(destination.protocol)) throw new Error('文献地址必须是 HTTP 或 HTTPS 地址');
  if (isProxyHost(destination.hostname, base.hostname)) return target;
  if (template.includes('$@')) return template.replace('$@', () => target);
  // Also accept an institution's bare host, as commonly pasted into settings.
  if (base.pathname === '/') base.pathname = '/login';
  base.searchParams.delete('url');
  const query = base.searchParams.toString();
  return `${base.origin}${base.pathname}?${query ? `${query}&` : ''}url=${target}${base.hash}`;
}

export function isProxyHost(host: string, proxyHost: string): boolean {
  return host === proxyHost || host.endsWith(`.${proxyHost}`);
}

function proxyHost(prefix: string): string {
  return new URL(proxyUrl('https://www.nature.com', prefix)).hostname;
}

async function proxyCookies(session: BrowserSession, host: string): Promise<Cookie[]> {
  return (await session.cookies.get({ domain: host })).filter((cookie) => isProxyHost(cookie.domain.replace(/^\./, ''), host));
}

export async function readProxyCookies(app: App, prefix: string, target = 'https://www.nature.com'): Promise<string> {
  if (bypassEzProxy(target)) return '';
  const loginUrl = new URL(proxyUrl(target, prefix));
  // Chromium includes applicable parent-domain and HttpOnly cookies for this URL.
  // Filtering by the configured host first incorrectly drops those cookies.
  const cookies = await browserSession(app).cookies.get({ url: loginUrl.href });
  // Match cookies to the actual proxy request's host and path.
  return cookies.filter((cookie) => {
    const path = cookie.path || '/';
    const domain = cookie.domain.replace(/^\./, '');
    const matchesHost = cookie.hostOnly ? domain === loginUrl.hostname : isProxyHost(loginUrl.hostname, domain);
    return matchesHost && (!cookie.secure || loginUrl.protocol === 'https:') &&
      (loginUrl.pathname === path || loginUrl.pathname.startsWith(path.endsWith('/') ? path : `${path}/`));
  })
    .map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function currentBrowserUrl(view: View): string {
  const browserView = view as View & { webview?: { getURL(): string } };
  const current = browserView.webview?.getURL();
  if (current) return current;
  const state = view.getState() as { url?: string };
  if (!state.url) throw new Error('无法读取当前网页地址，请等待页面加载完成后重试');
  return state.url;
}

export async function clearProxyCookies(app: App, prefix: string): Promise<void> {
  const session = browserSession(app);
  const cookies = await proxyCookies(session, proxyHost(prefix));
  for (const cookie of cookies) {
    await session.cookies.remove(`${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`, cookie.name);
  }
}

export class EzProxyLogin {
  private cancel?: () => void;

  dispose(): void { this.cancel?.(); }

  async open(app: BrowserApp, prefix: string, target: string, save: (cookies: string) => Promise<void>): Promise<void> {
    if (this.cancel) throw new Error('已有登录页面，请在该页面完成或取消登录');
    const url = proxyUrl(target, prefix);
    if (!app.internalPlugins?.getEnabledPluginById('webviewer')) {
      throw new Error('请先在“设置 → 核心插件”中启用“网页浏览器（Web viewer）”；此功能需要支持网页浏览器的 Obsidian 桌面版');
    }
    browserSession(app);
    const leaf = app.workspace.getLeaf('tab');
    try {
      await leaf.setViewState({ type: 'webviewer', active: true, state: { url, navigate: true } });
    } catch (error) { leaf.detach(); throw error; }
    if (leaf.view.getViewType() !== 'webviewer') {
      leaf.detach();
      throw new Error('无法打开网页浏览器，请确认核心插件已启用');
    }
    await app.workspace.revealLeaf(leaf);
    app.setting?.close();

    return new Promise<void>((resolve, reject) => {
      const banner = leaf.view.containerEl.createDiv({ cls: 'ai-rss-ezproxy-login', prepend: true });
      banner.createSpan({ text: '完成机构登录并看到文献页面后，点击“完成登录”。' });
      const done = banner.createEl('button', { text: '完成登录', cls: 'mod-cta' });
      const cancel = banner.createEl('button', { text: '取消' });
      let finished = false;
      const cleanup = (): void => {
        finished = true;
        banner.remove();
        app.workspace.offref(closed);
        this.cancel = undefined;
      };
      this.cancel = () => { cleanup(); reject(new Error('已取消 EZProxy 登录')); };
      const closed = app.workspace.on('layout-change', () => {
        if (!app.workspace.getLeavesOfType('webviewer').includes(leaf)) this.cancel?.();
      });
      cancel.addEventListener('click', () => this.cancel?.());
      done.addEventListener('click', () => {
        done.disabled = true;
        void (async () => {
          try {
            const currentUrl = currentBrowserUrl(leaf.view);
            const current = new URL(currentUrl);
            const host = proxyHost(prefix);
            if (!['https:', 'http:'].includes(current.protocol) || !isProxyHost(current.hostname, host)) {
              throw new Error('当前页面还未返回机构代理，请在文献页面打开后点击“完成登录”');
            }
            // A cookie is not evidence of authentication, and its absence at the
            // login host is not evidence of failure after a publisher redirect.
            if (current.hostname === host && /^\/(?:login|logout|auth)(?:\/|$)/i.test(current.pathname)) {
              throw new Error('当前仍在机构登录页面，请返回文献页面后再完成登录');
            }
            const cookies = await readProxyCookies(app, prefix, currentUrl);
            if (finished) return;
            if (currentBrowserUrl(leaf.view) !== currentUrl) throw new Error('页面正在跳转，请等待加载完成后重试');
            await save(cookies);
            if (finished) return;
            cleanup();
            new Notice('EZProxy 会话已记录，可以继续保存文献');
            resolve();
          } catch (error) {
            if (!finished) { new Notice(String(error), 8000); done.disabled = false; }
          }
        })();
      });
    });
  }
}
