import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import type { DataAdapter } from 'obsidian';

export const RULES_FOLDER = 'AI RSS Reader/rules';
export interface CleaningRule {
  version: 1;
  name: string;
  enabled?: boolean;
  contentSelector?: string;
  removeSelectors?: string[];
  unwrapSelectors?: string[];
  preserve?: { images?: boolean; captions?: boolean; tables?: boolean; footnotes?: boolean };
  restoreProxyLinks?: boolean;
  proxyHosts?: Record<string, string>;
  replacements?: { find: string; replace: string; regex?: boolean; flags?: string }[];
}
type RuleAdapter = Pick<DataAdapter, 'exists' | 'mkdir' | 'read' | 'write'>;
const initialization = new WeakMap<RuleAdapter, Promise<void>>();

export function ruleFilename(name: string): string {
  if (!name) throw new Error('RSS 来源名称不能为空');
  let filename = name.replace(/[%<>:"/\\|?*\u0000-\u001f]/g, c => encodeURIComponent(c));
  filename = filename.replace(/[. ]+$/, s => Array.from(s, c => '%' + c.charCodeAt(0).toString(16)).join(''));
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename) || filename === '_common') {
    filename = '%' + filename.charCodeAt(0).toString(16) + filename.slice(1);
  }
  return `${filename}.json`;
}

export function defaultRule(name: string): CleaningRule {
  const rule: CleaningRule = { version: 1, name, enabled: true, removeSelectors: [], unwrapSelectors: [], replacements: [] };
  if (name === '_common') rule.preserve = { images: true, captions: true, tables: true, footnotes: true };
  if (['Nature', 'Nature Communication', 'Nature Communications', 'Nature Electronics'].includes(name)) {
    rule.preserve = { images: true, captions: true, tables: true, footnotes: true };
    rule.restoreProxyLinks = true;
    rule.proxyHosts = { 'www-nature-com': 'www.nature.com', 'doi-org': 'doi.org' };
  }
  return rule;
}

// Existing files are always user-owned. Missing files are initialized only.
export async function ensureRuleFiles(adapter: RuleAdapter, names: string[]): Promise<void> {
  const previous = initialization.get(adapter) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => initializeFiles(adapter, names));
  initialization.set(adapter, next);
  return next;
}

async function initializeFiles(adapter: RuleAdapter, names: string[]): Promise<void> {
  for (const path of ['AI RSS Reader', RULES_FOLDER]) {
    if (!await adapter.exists(path)) await adapter.mkdir(path);
  }
  const files = [['_common', '_common.json'], ...Array.from(new Set(names), name => [name, ruleFilename(name)])];
  for (const [name, filename] of files) {
    const path = `${RULES_FOLDER}/${filename}`;
    if (!await adapter.exists(path)) await adapter.write(path, JSON.stringify(defaultRule(name), null, 2) + '\n');
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`未知字段：${key}`);
}
export function parseRule(text: string, name: string): CleaningRule {
  const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(value)) throw new Error('规则必须是 JSON 对象');
  keys(value, ['version', 'name', 'enabled', 'contentSelector', 'removeSelectors', 'unwrapSelectors', 'preserve', 'restoreProxyLinks', 'proxyHosts', 'replacements']);
  if (value.version !== 1 || value.name !== name) throw new Error(`version 必须为 1，name 必须为 ${name}`);
  for (const key of ['enabled', 'restoreProxyLinks']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
  }
  if (value.contentSelector !== undefined && (typeof value.contentSelector !== 'string' || !value.contentSelector.trim())) throw new Error('contentSelector 必须是非空 CSS 选择器');
  for (const key of ['removeSelectors', 'unwrapSelectors']) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(s => typeof s === 'string' && s.trim()))) throw new Error(`${key} 必须是选择器字符串数组`);
  }
  if (value.preserve !== undefined) {
    if (!object(value.preserve)) throw new Error('preserve 必须是对象');
    keys(value.preserve, ['images', 'captions', 'tables', 'footnotes']);
    if (!Object.values(value.preserve).every(v => typeof v === 'boolean')) throw new Error('preserve 的值必须是布尔值');
  }
  if (value.proxyHosts !== undefined && (!object(value.proxyHosts) || !Object.entries(value.proxyHosts).every(([k, v]) => /^[a-z0-9.-]+$/i.test(k) && typeof v === 'string' && /^[a-z0-9.-]+$/i.test(v)))) throw new Error('proxyHosts 必须是主机名映射');
  if (value.replacements !== undefined) {
    if (!Array.isArray(value.replacements)) throw new Error('replacements 必须是数组');
    for (const replacement of value.replacements) {
      if (!object(replacement)) throw new Error('替换规则必须是对象');
      keys(replacement, ['find', 'replace', 'regex', 'flags']);
      if (typeof replacement.find !== 'string' || !replacement.find || typeof replacement.replace !== 'string') throw new Error('替换规则需要非空 find 和字符串 replace');
      if (replacement.regex !== undefined && typeof replacement.regex !== 'boolean') throw new Error('regex 必须是布尔值');
      if (replacement.flags !== undefined && (typeof replacement.flags !== 'string' || !/^[gimsu]*$/.test(replacement.flags))) throw new Error('flags 仅支持 gimsu');
      if (replacement.regex) new RegExp(replacement.find, replacement.flags as string | undefined ?? 'g');
      else if (replacement.flags !== undefined) throw new Error('flags 仅用于正则替换');
    }
  }
  return value as unknown as CleaningRule;
}

export async function loadRules(adapter: RuleAdapter, name: string): Promise<CleaningRule[]> {
  // Read on every capture so edits take effect without reloading the plugin.
  const result: CleaningRule[] = [];
  for (const [expected, filename] of [['_common', '_common.json'], [name, ruleFilename(name)]]) {
    const path = `${RULES_FOLDER}/${filename}`;
    if (!await adapter.exists(path)) continue;
    try { result.push(parseRule(await adapter.read(path), expected)); }
    catch (error) { throw new Error(`${path}：${error instanceof Error ? error.message : String(error)}`); }
  }
  return result.filter(rule => rule.enabled !== false);
}

export async function cleanArticle(adapter: RuleAdapter, name: string, doc: Document, pageUrl: string, canonicalUrl: string, warnings: string[]): Promise<string> {
  try {
    await ensureRuleFiles(adapter, [name]);
    return convertArticle(doc, pageUrl, canonicalUrl, await loadRules(adapter, name));
  } catch (error) {
    warnings.push(`清洗规则未应用，已回退默认 Markdown 转换：${error instanceof Error ? error.message : String(error)}`);
    return convertArticle(doc, pageUrl, canonicalUrl);
  }
}

function rewriteProxyLinks(doc: Document, pageUrl: string, canonicalUrl: string, hosts: Record<string, string>): void {
  const page = new URL(pageUrl), canonical = new URL(canonicalUrl);
  const prefixes = [canonical.hostname.replace(/\./g, '-'), canonical.hostname];
  const prefix = prefixes.find(p => page.hostname.startsWith(p + '.'));
  if (!prefix) return;
  const suffix = page.hostname.slice(prefix.length);
  const mappings = { ...hosts, [prefix]: canonical.hostname };
  for (const element of Array.from(doc.querySelectorAll('[href], [src], [poster], [srcset]'))) {
    const rewrite = (value: string): string => {
      if (value.startsWith('#')) return value;
      try {
        const url = new URL(value, pageUrl);
        if (!['http:', 'https:'].includes(url.protocol)) return value;
        for (const [proxy, original] of Object.entries(mappings)) {
          if (url.hostname === proxy + suffix) { url.hostname = original; return url.href; }
        }
      } catch { /* Retain URLs that cannot be parsed. */ }
      return value;
    };
    for (const attr of ['href', 'src', 'poster']) {
      const value = element.getAttribute(attr);
      if (value) element.setAttribute(attr, rewrite(value));
    }
    const srcset = element.getAttribute('srcset');
    if (srcset) element.setAttribute('srcset', srcset.replace(/https?:\/\/[^\s,]+/g, rewrite));
  }
}

export function convertArticle(doc: Document, pageUrl: string, canonicalUrl: string, rules: CleaningRule[] = []): string {
  const working = doc.cloneNode(true) as Document;
  const preserve = { images: true, captions: true, tables: true, footnotes: true };
  let restoreProxyLinks = false;
  let hosts: Record<string, string> = {};
  for (const rule of rules) {
    try {
      if (rule.contentSelector) {
        const elements = Array.from(working.querySelectorAll(rule.contentSelector));
        if (!elements.length) throw new Error(`正文选择器没有匹配元素：${rule.contentSelector}`);
        // Avoid duplicating nested matches, and retain the original metadata head.
        const roots = elements.filter(el => !elements.some(other => other !== el && other.contains(el)));
        working.body.replaceChildren(...roots.map(el => el.cloneNode(true)));
      }
      for (const selector of rule.removeSelectors ?? []) working.querySelectorAll(selector).forEach(el => el.remove());
      for (const selector of rule.unwrapSelectors ?? []) working.querySelectorAll(selector).forEach(el => el.replaceWith(...Array.from(el.childNodes)));
      Object.assign(preserve, rule.preserve);
      restoreProxyLinks = rule.restoreProxyLinks ?? restoreProxyLinks;
      hosts = { ...hosts, ...rule.proxyHosts };
    } catch (error) { throw new Error(`规则 ${rule.name}：${error instanceof Error ? error.message : String(error)}`); }
  }
  const parsed = new Defuddle(working, { url: pageUrl, useAsync: false }).parse();
  const content = new DOMParser().parseFromString(parsed.content, 'text/html');
  if (!preserve.images) content.querySelectorAll('img, picture').forEach(el => el.remove());
  if (!preserve.captions) content.querySelectorAll('figcaption').forEach(el => el.remove());
  if (!preserve.tables) content.querySelectorAll('table').forEach(el => el.remove());
  if (!preserve.footnotes) content.querySelectorAll('[id^="fnref:"], [id^="fn:"], .footnotes, #footnotes').forEach(el => el.remove());
  if (restoreProxyLinks) rewriteProxyLinks(content, pageUrl, canonicalUrl, hosts);
  let markdown = createMarkdownContent(content.body.innerHTML, pageUrl);
  if (markdown.startsWith('Partial conversion completed with errors. Original HTML:')) throw new Error('HTML → Markdown 转换失败');
  for (const rule of rules) {
    for (const replacement of rule.replacements ?? []) {
      markdown = replacement.regex
        ? markdown.replace(new RegExp(replacement.find, replacement.flags ?? 'g'), replacement.replace)
        : markdown.split(replacement.find).join(replacement.replace);
    }
  }
  if (!markdown.trim()) throw new Error('清洗后正文为空');
  return markdown.trim();
}
