import { App, TFile, normalizePath, requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { unzipSync } from 'fflate';
import type { AiRssSettings } from './types';

const STANDARD_BASE = 'https://mineru.net/api/v4';
const AGENT_BASE = 'https://mineru.net/api/v1/agent';
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;

type Requester = (request: RequestUrlParam | string) => Promise<RequestUrlResponse>;
type Sleeper = (milliseconds: number) => Promise<void>;

export interface MinerUParseResult {
  mode: 'standard' | 'agent';
  markdown?: string;
  archive?: ArrayBuffer;
}

export interface MinerUSavedResult {
  folder: string;
  paths: string[];
  mode: 'standard' | 'agent';
}

export interface MinerUOutput {
  path: string;
  data: string | Uint8Array;
}

interface ApiEnvelope {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

interface StandardExtractResult {
  state?: string;
  full_zip_url?: string;
  err_msg?: string;
}

export async function parsePdfWithMinerU(
  pdf: ArrayBuffer,
  fileName: string,
  settings: AiRssSettings,
  progress: (message: string) => void = () => undefined,
  requester: Requester = requestUrl,
  sleep: Sleeper = milliseconds => new Promise(resolve => window.setTimeout(resolve, milliseconds)),
): Promise<MinerUParseResult> {
  const tokenConfigured = Boolean(settings.mineruToken.trim());
  const limit = tokenConfigured ? 200 * 1024 * 1024 : 10 * 1024 * 1024;
  if (pdf.byteLength > limit) throw new Error(tokenConfigured
    ? 'PDF 超过标准 API 的 200 MB 限制'
    : 'PDF 超过轻量 Agent API 的 10 MB 限制，请配置 MinerU Token 后重试');
  return settings.mineruToken.trim()
    ? parseWithStandardApi(pdf, fileName, settings, progress, requester, sleep)
    : parseWithAgentApi(pdf, fileName, settings, progress, requester, sleep);
}

async function parseWithStandardApi(
  pdf: ArrayBuffer,
  fileName: string,
  settings: AiRssSettings,
  progress: (message: string) => void,
  requester: Requester,
  sleep: Sleeper,
): Promise<MinerUParseResult> {
  const headers = { Authorization: `Bearer ${settings.mineruToken.trim()}`, 'Content-Type': 'application/json' };
  progress('正在向 MinerU 申请上传地址');
  const submitted = await jsonRequest(requester, {
    url: `${STANDARD_BASE}/file-urls/batch`, method: 'POST', headers,
    body: JSON.stringify({
      files: [{ name: fileName, data_id: makeDataId(), is_ocr: settings.mineruOcr }],
      model_version: settings.mineruModelVersion,
      language: settings.mineruLanguage.trim() || 'en',
      enable_table: settings.mineruEnableTable,
      enable_formula: settings.mineruEnableFormula,
    }),
  });
  const batchId = stringField(submitted.data, 'batch_id');
  const uploadUrl = arrayStringField(submitted.data, 'file_urls')[0];
  if (!batchId || !uploadUrl) throw new Error('MinerU 没有返回有效的批次或上传地址');

  progress('正在上传 PDF 到 MinerU');
  await uploadPdf(requester, uploadUrl, pdf);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const status = await jsonRequest(requester, {
      url: `${STANDARD_BASE}/extract-results/batch/${encodeURIComponent(batchId)}`,
      method: 'GET', headers,
    });
    const items = Array.isArray(status.data?.extract_result) ? status.data.extract_result as StandardExtractResult[] : [];
    const item = items[0];
    if (!item) continue;
    if (item.state === 'failed') throw new Error(item.err_msg || 'MinerU 解析失败');
    if (item.state !== 'done') {
      progress(`MinerU 正在解析（${stateLabel(item.state)}）`);
      continue;
    }
    if (!item.full_zip_url) throw new Error('MinerU 任务完成，但没有返回结果 ZIP');
    progress('正在下载 MinerU 完整解析结果');
    const downloaded = await requester({ url: item.full_zip_url, method: 'GET', throw: false });
    ensureHttpOk(downloaded, '下载 MinerU ZIP');
    return { mode: 'standard', archive: downloaded.arrayBuffer };
  }
  throw new Error('等待 MinerU 解析超时（10 分钟）');
}

async function parseWithAgentApi(
  pdf: ArrayBuffer,
  fileName: string,
  settings: AiRssSettings,
  progress: (message: string) => void,
  requester: Requester,
  sleep: Sleeper,
): Promise<MinerUParseResult> {
  if (!settings.mineruSaveMarkdown) throw new Error('轻量 Agent API 只返回 Markdown，请先在设置中启用保存 Markdown');
  progress('正在向 MinerU 轻量 API 申请上传地址');
  const submitted = await jsonRequest(requester, {
    url: `${AGENT_BASE}/parse/file`, method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file_name: fileName,
      language: settings.mineruLanguage.trim() || 'en',
      is_ocr: settings.mineruOcr,
      enable_table: settings.mineruEnableTable,
      enable_formula: settings.mineruEnableFormula,
    }),
  });
  const taskId = stringField(submitted.data, 'task_id');
  const uploadUrl = stringField(submitted.data, 'file_url');
  if (!taskId || !uploadUrl) throw new Error('MinerU 轻量 API 没有返回有效的任务或上传地址');

  progress('正在上传 PDF 到 MinerU 轻量 API');
  await uploadPdf(requester, uploadUrl, pdf);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const status = await jsonRequest(requester, { url: `${AGENT_BASE}/parse/${encodeURIComponent(taskId)}`, method: 'GET' });
    const state = stringField(status.data, 'state');
    if (state === 'failed') throw new Error(stringField(status.data, 'err_msg') || 'MinerU 轻量解析失败');
    if (state !== 'done') {
      progress(`MinerU 正在解析（${stateLabel(state)}）`);
      continue;
    }
    const markdownUrl = stringField(status.data, 'markdown_url');
    if (!markdownUrl) throw new Error('MinerU 任务完成，但没有返回 Markdown 地址');
    progress('正在下载 MinerU Markdown');
    const downloaded = await requester({ url: markdownUrl, method: 'GET', throw: false });
    ensureHttpOk(downloaded, '下载 MinerU Markdown');
    return { mode: 'agent', markdown: downloaded.text };
  }
  throw new Error('等待 MinerU 解析超时（10 分钟）');
}

export async function saveMinerUResult(
  app: App,
  pdfFile: TFile,
  result: MinerUParseResult,
  settings: AiRssSettings,
): Promise<MinerUSavedResult> {
  const folder = normalizePath([pdfFile.parent?.path, 'Miner_U'].filter(Boolean).join('/'));
  await ensureFolder(app, folder);
  const base = `${pdfFile.basename}_MinerU`;
  const outputs = result.archive
    ? buildArchiveOutputs(result.archive, folder, base, settings)
    : result.markdown !== undefined && settings.mineruSaveMarkdown
      ? [{ path: normalizePath(`${folder}/${base}.md`), data: postprocessMinerUMarkdown(result.markdown) }]
      : [];
  if (outputs.length === 0) throw new Error('当前保存选项没有产生任何文件');
  for (const output of outputs) {
    await ensureFolder(app, output.path.split('/').slice(0, -1).join('/'));
    await writeOutput(app, output);
  }
  return { folder, paths: outputs.map(output => output.path), mode: result.mode };
}

export function buildArchiveOutputs(
  archive: ArrayBuffer,
  folder: string,
  base: string,
  settings: Pick<AiRssSettings,
    'mineruSaveMarkdown' | 'mineruSaveContentListJson' | 'mineruSaveLayoutJson' |
    'mineruSaveModelJson' | 'mineruSaveImages' | 'mineruSaveOtherFiles'>,
  jpegConverter: (input: Uint8Array) => Uint8Array = convertToJpeg,
): MinerUOutput[] {
  const entries = Object.entries(unzipSync(new Uint8Array(archive)))
    .filter(([name]) => !name.endsWith('/'))
    .map(([name, data]) => ({ name: normalizeArchivePath(name), data }));
  const markdownEntry = entries.find(entry => /(^|\/)full\.md$/i.test(entry.name))
    ?? entries.find(entry => /\.md$/i.test(entry.name));
  let markdown = markdownEntry ? new TextDecoder().decode(markdownEntry.data) : '';
  const outputs: MinerUOutput[] = [];

  const imageEntries = entries.filter(entry => /\.(?:png|jpe?g|webp|bmp|gif|tiff?|jp2)$/i.test(entry.name));
  const orderedImages = orderImagesByMarkdown(imageEntries, markdown);
  const imageNames = new Map<string, string>();
  orderedImages.forEach((entry, index) => {
    const target = `Figures/${base}_${index + 1}.jpg`;
    imageNames.set(entry.name, target);
    imageNames.set(archiveBasename(entry.name), target);
    if (settings.mineruSaveImages) outputs.push({ path: normalizePath(`${folder}/${target}`), data: jpegConverter(entry.data) });
  });
  if (settings.mineruSaveImages && markdown) markdown = rewriteMarkdownImages(markdown, imageNames);
  if (settings.mineruSaveMarkdown && markdownEntry) outputs.unshift({ path: normalizePath(`${folder}/${base}.md`), data: postprocessMinerUMarkdown(markdown) });

  for (const entry of entries.filter(item => /\.json$/i.test(item.name))) {
    const lower = archiveBasename(entry.name).toLowerCase();
    let suffix = '';
    if (lower.includes('content_list') && settings.mineruSaveContentListJson) suffix = 'content_list';
    else if ((lower.includes('middle') || lower === 'layout.json' || lower.endsWith('_layout.json')) && settings.mineruSaveLayoutJson) suffix = 'layout';
    else if (lower.includes('model') && settings.mineruSaveModelJson) suffix = 'model';
    else if (settings.mineruSaveOtherFiles) suffix = uniqueOtherSuffix(outputs, base, sanitizePart(archiveBasename(entry.name).replace(/\.json$/i, '')));
    if (suffix) outputs.push({ path: normalizePath(`${folder}/${base}_${suffix}.json`), data: entry.data });
  }

  if (settings.mineruSaveOtherFiles) {
    const reserved = new Set(entries.filter(entry => entry === markdownEntry || imageEntries.includes(entry) || /\.json$/i.test(entry.name)));
    for (const entry of entries.filter(item => !reserved.has(item) && !/\.pdf$/i.test(item.name))) {
      const original = archiveBasename(entry.name);
      const dot = original.lastIndexOf('.');
      const stem = sanitizePart(dot > 0 ? original.slice(0, dot) : original);
      const extension = dot > 0 ? original.slice(dot).toLowerCase() : '';
      const suffix = uniqueOtherSuffix(outputs, base, stem);
      outputs.push({ path: normalizePath(`${folder}/${base}_${suffix}${extension}`), data: entry.data });
    }
  }
  return outputs;
}

export function postprocessMinerUMarkdown(markdown: string): string {
  const lines = markdown.split('\n');
  const referencesHeading = lines.findIndex(line => /^\s*#{1,6}\s*(?:references|bibliography|参考文献|参考资料)\s*#*\s*$/i.test(line));
  const referenceNumbers = new Set<string>();
  if (referencesHeading >= 0) {
    for (let index = referencesHeading + 1; index < lines.length; index += 1) {
      const match = lines[index].match(/^\s*\[\^?(\d+)\](?::)?(?:\s+|$)/);
      if (match) referenceNumbers.add(match[1]);
    }
  }

  return lines.map((line, index) => {
    if (referencesHeading >= 0 && index > referencesHeading) {
      return line.replace(/^(\s*)\[(\d+)\]\s*/, '$1[^$2]: ');
    }
    return line.replace(/(^|[^!\\[])\[([0-9][0-9\s,，\-–—]*)\](?!\()/g, (match, prefix: string, citation: string) => {
      const numbers = expandCitationNumbers(citation);
      if (!numbers || (referenceNumbers.size > 0 && numbers.some(number => !referenceNumbers.has(number)))) return match;
      return `${prefix}${numbers.map(number => `[^${number}]`).join(',')}`;
    });
  }).join('\n');
}

function expandCitationNumbers(value: string): string[] | undefined {
  const output: string[] = [];
  for (const rawPart of value.split(/[,，]/)) {
    const part = rawPart.trim();
    const range = part.match(/^(\d+)\s*[-–—]\s*(\d+)$/);
    if (range) {
      const start = Number.parseInt(range[1], 10);
      const end = Number.parseInt(range[2], 10);
      if (end < start || end - start > 100) return undefined;
      for (let number = start; number <= end; number += 1) output.push(String(number));
      continue;
    }
    if (!/^\d+$/.test(part)) return undefined;
    output.push(String(Number.parseInt(part, 10)));
  }
  return output.length > 0 ? output : undefined;
}

async function jsonRequest(requester: Requester, request: RequestUrlParam): Promise<ApiEnvelope> {
  const response = await requester({ ...request, throw: false });
  ensureHttpOk(response, '调用 MinerU API');
  const envelope = response.json as ApiEnvelope;
  if (!envelope || typeof envelope !== 'object') throw new Error('MinerU 返回了无法识别的响应');
  if (envelope.code !== 0) throw new Error(envelope.msg || `MinerU API 错误：${String(envelope.code)}`);
  return envelope;
}

async function uploadPdf(requester: Requester, url: string, pdf: ArrayBuffer): Promise<void> {
  const response = await requester({ url, method: 'PUT', body: pdf, throw: false });
  ensureHttpOk(response, '上传 PDF');
}

function ensureHttpOk(response: RequestUrlResponse, action: string): void {
  if (response.status < 200 || response.status >= 300) throw new Error(`${action}失败：HTTP ${response.status}`);
}

function stringField(data: Record<string, unknown> | undefined, field: string): string {
  const value = data?.[field];
  return typeof value === 'string' ? value : '';
}

function arrayStringField(data: Record<string, unknown> | undefined, field: string): string[] {
  const value = data?.[field];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stateLabel(state: string | undefined): string {
  return ({ 'waiting-file': '等待上传', uploading: '读取文件', pending: '排队中', running: '处理中', converting: '生成结果' } as Record<string, string>)[state || ''] || state || '等待中';
}

function makeDataId(): string {
  return `obsidian-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeArchivePath(value: string): string {
  let decoded = value.replace(/\\/g, '/').replace(/^\.\//, '');
  try { decoded = decodeURIComponent(decoded); } catch { /* Keep malformed URI text unchanged. */ }
  return decoded;
}

function archiveBasename(value: string): string {
  return value.split('/').pop() || value;
}

function orderImagesByMarkdown<T extends { name: string }>(images: T[], markdown: string): T[] {
  const byName = new Map<string, T>();
  images.forEach(image => { byName.set(image.name, image); byName.set(archiveBasename(image.name), image); });
  const ordered: T[] = [];
  const seen = new Set<T>();
  const references = [...markdown.matchAll(/!\[[^\]]*\]\((?:<)?([^)>\s]+)(?:>)?(?:\s+["'][^)]*["'])?\)/g), ...markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)];
  for (const match of references) {
    const key = normalizeArchivePath(match[1].split(/[?#]/, 1)[0]);
    const image = byName.get(key) ?? byName.get(archiveBasename(key));
    if (image && !seen.has(image)) { ordered.push(image); seen.add(image); }
  }
  images.filter(image => !seen.has(image)).sort((a, b) => a.name.localeCompare(b.name)).forEach(image => ordered.push(image));
  return ordered;
}

function rewriteMarkdownImages(markdown: string, names: Map<string, string>): string {
  const replacement = (value: string): string => {
    const normalized = normalizeArchivePath(value.split(/[?#]/, 1)[0]);
    return names.get(normalized) ?? names.get(archiveBasename(normalized)) ?? value;
  };
  return markdown
    .replace(/(!\[[^\]]*\]\()(<?)([^)>\s]+)(>?)(\s+["'][^)]*["'])?(\))/g, (_all, open, left, path, right, title = '', close) => `${open}${left}${replacement(path)}${right}${title}${close}`)
    .replace(/(<img\b[^>]*\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (_all, open, path, close) => `${open}${replacement(path)}${close}`);
}

function convertToJpeg(input: Uint8Array): Uint8Array {
  const electron = require('electron') as { nativeImage?: { createFromBuffer(buffer: Buffer): { isEmpty(): boolean; toJPEG(quality: number): Buffer } } };
  const image = electron.nativeImage?.createFromBuffer(Buffer.from(input));
  if (!image || image.isEmpty()) throw new Error('MinerU 返回了一张无法转换为 JPG 的图片');
  return new Uint8Array(image.toJPEG(92));
}

function sanitizePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').replace(/^\.+|\.+$/g, '').slice(0, 80) || 'file';
}

function uniqueOtherSuffix(outputs: MinerUOutput[], base: string, requested: string): string {
  let suffix = requested || 'file';
  let index = 2;
  while (outputs.some(output => archiveBasename(output.path).startsWith(`${base}_${suffix}.`) || archiveBasename(output.path).startsWith(`${base}_${suffix}_`))) suffix = `${requested}_${index++}`;
  return suffix;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path || app.vault.getAbstractFileByPath(path)) return;
  const parent = path.split('/').slice(0, -1).join('/');
  if (parent) await ensureFolder(app, parent);
  if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
}

async function writeOutput(app: App, output: MinerUOutput): Promise<void> {
  const existing = app.vault.getFileByPath(output.path);
  if (typeof output.data === 'string') {
    if (existing) await app.vault.modify(existing, output.data);
    else await app.vault.create(output.path, output.data);
    return;
  }
  const binary = output.data.buffer.slice(output.data.byteOffset, output.data.byteOffset + output.data.byteLength) as ArrayBuffer;
  if (existing) await app.vault.modifyBinary(existing, binary);
  else await app.vault.createBinary(output.path, binary);
}
