import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { delimiter, join } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationWaiter {
  method: string;
  predicate: (params: unknown) => boolean;
  resolve: (params: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexAccountStatus {
  signedIn: boolean;
  authType?: 'chatgpt' | 'apiKey' | 'amazonBedrock';
  planType?: string;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
}

interface AccountReadResult {
  account?: {
    type?: string;
    planType?: string;
  } | null;
}

interface LoginStartResult {
  type?: string;
  loginId?: string;
  authUrl?: string;
}

interface ThreadStartResult {
  thread?: { id?: string };
}

interface TurnStartResult {
  turn?: { id?: string };
}

interface ModelListResult {
  data?: Array<{
    id?: string;
    model?: string;
    displayName?: string;
    hidden?: boolean;
    isDefault?: boolean;
  }>;
  nextCursor?: string | null;
}

const CLIENT_INFO = {
  name: 'obsidian_ai_rss_reader',
  title: 'Obsidian AI RSS Reader',
  version: '0.1.0',
};

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function executableName(value: string): string {
  const configured = value.trim() || 'codex';
  if (configured.toLowerCase() !== 'codex' || process.platform !== 'win32') return configured;
  const pathCandidates = (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => [join(directory, 'codex.exe'), join(directory, 'codex.cmd')]);
  for (const candidate of pathCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return configured;
  const binDirectory = join(localAppData, 'OpenAI', 'Codex', 'bin');
  const desktopCandidates = [join(binDirectory, 'codex.exe')];
  try {
    for (const entry of readdirSync(binDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) desktopCandidates.push(join(binDirectory, entry.name, 'codex.exe'));
    }
  } catch {
    return configured;
  }
  return desktopCandidates
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => {
      try { return statSync(right).mtimeMs - statSync(left).mtimeMs; }
      catch { return 0; }
    })[0] || configured;
}

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationWaiters = new Set<NotificationWaiter>();
  private readonly recentNotifications: Array<{ method: string; params: unknown }> = [];
  private nextId = 1;
  private stderr = '';
  private closed = false;

  private constructor(executable: string) {
    this.child = spawn(executableName(executable), ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', (line) => this.handleLine(line));
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-3000);
    });
    this.child.once('error', (error) => this.failAll(new Error(`无法启动 Codex：${error.message}`)));
    this.child.once('exit', (code, signal) => {
      if (this.closed) return;
      const details = this.stderr.trim();
      this.failAll(new Error(`Codex app-server 已退出（${signal || (code ?? '未知原因')}）${details ? `：${details.slice(-500)}` : ''}`));
    });
  }

  static async connect(executable: string): Promise<CodexAppServerClient> {
    const client = new CodexAppServerClient(executable);
    try {
      await client.request('initialize', { clientInfo: CLIENT_INFO }, 20_000);
      client.notify('initialized', {});
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) throw new Error('Codex app-server 连接已关闭');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.write({ method, id, params });
    });
  }

  waitForNotification<T>(method: string, predicate: (params: T) => boolean, timeoutMs: number): Promise<T> {
    const recentIndex = this.recentNotifications.findIndex((item) => item.method === method && predicate(item.params as T));
    if (recentIndex >= 0) {
      const [notification] = this.recentNotifications.splice(recentIndex, 1);
      return Promise.resolve(notification.params as T);
    }
    return new Promise<T>((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate: (params) => predicate(params as T),
        resolve: (params) => resolve(params as T),
        reject,
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error(`等待 Codex 事件超时：${method}`));
        }, timeoutMs),
      };
      this.notificationWaiters.add(waiter);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
    this.failAll(new Error('Codex app-server 连接已关闭'));
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(message: JsonRpcMessage): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.failAll(new Error(`无法向 Codex 发送请求：${errorMessage(error)}`));
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex：${message.error.message || `请求失败 (${message.error.code ?? 'unknown'})`}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.write({ id: message.id, error: { code: -32601, message: `客户端不支持服务端请求：${message.method}` } });
      return;
    }
    if (!message.method) return;
    let delivered = false;
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      delivered = true;
      this.notificationWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(message.params);
    }
    if (!delivered) {
      this.recentNotifications.push({ method: message.method, params: message.params });
      if (this.recentNotifications.length > 50) this.recentNotifications.shift();
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.notificationWaiters.clear();
  }
}

function accountStatus(result: AccountReadResult): CodexAccountStatus {
  const account = result.account;
  if (!account?.type) return { signedIn: false };
  if (account.type === 'chatgpt') return { signedIn: true, authType: 'chatgpt', planType: account.planType };
  if (account.type === 'apiKey') return { signedIn: true, authType: 'apiKey' };
  if (account.type === 'amazonBedrock') return { signedIn: true, authType: 'amazonBedrock' };
  return { signedIn: true };
}

async function listModels(client: CodexAppServerClient): Promise<CodexModelOption[]> {
  const models: CodexModelOption[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const params: Record<string, unknown> = { limit: 100, includeHidden: false };
    if (cursor) params.cursor = cursor;
    const result = await client.request<ModelListResult>('model/list', params);
    for (const item of result.data || []) {
      const model = (item.model || item.id || '').trim();
      if (!model || item.hidden || seen.has(model)) continue;
      seen.add(model);
      models.push({
        id: (item.id || model).trim(),
        model,
        displayName: (item.displayName || model).trim(),
        isDefault: item.isDefault === true,
      });
    }
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return models;
}

function resolveModel(models: CodexModelOption[], requested: string): string | undefined {
  const normalized = requested.trim().toLowerCase();
  if (!normalized) return undefined;
  return models.find((item) =>
    item.model.toLowerCase() === normalized
    || item.id.toLowerCase() === normalized
    || item.displayName.toLowerCase() === normalized
  )?.model;
}

export async function readCodexAccount(executable = 'codex'): Promise<CodexAccountStatus> {
  const client = await CodexAppServerClient.connect(executable);
  try {
    return accountStatus(await client.request<AccountReadResult>('account/read', { refreshToken: false }));
  } finally {
    client.close();
  }
}

export async function readCodexModels(executable = 'codex'): Promise<CodexModelOption[]> {
  const client = await CodexAppServerClient.connect(executable);
  try {
    const status = accountStatus(await client.request<AccountReadResult>('account/read', { refreshToken: false }));
    if (!status.signedIn || status.authType !== 'chatgpt') throw new Error('请先登录 ChatGPT Plus/Pro (Codex)');
    return await listModels(client);
  } finally {
    client.close();
  }
}

export async function loginCodexAccount(executable: string, openUrl: (url: string) => Promise<unknown>): Promise<CodexAccountStatus> {
  const client = await CodexAppServerClient.connect(executable);
  try {
    const result = await client.request<LoginStartResult>('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    });
    if (result.type !== 'chatgpt' || !result.loginId || !result.authUrl) throw new Error('Codex 未返回有效的 ChatGPT 登录地址');
    await openUrl(result.authUrl);
    const completed = await client.waitForNotification<{ loginId?: string; success?: boolean; error?: string | null }>(
      'account/login/completed',
      (params) => params.loginId === result.loginId,
      10 * 60_000,
    );
    if (!completed.success) throw new Error(completed.error || 'ChatGPT 登录未完成');
    return accountStatus(await client.request<AccountReadResult>('account/read', { refreshToken: false }));
  } finally {
    client.close();
  }
}

export async function logoutCodexAccount(executable = 'codex'): Promise<void> {
  const client = await CodexAppServerClient.connect(executable);
  try {
    await client.request('account/logout');
  } finally {
    client.close();
  }
}

export async function callCodexModel(
  executable: string,
  model: string,
  prompt: string,
  outputSchema: Record<string, unknown>,
): Promise<string> {
  const client = await CodexAppServerClient.connect(executable);
  try {
    const status = accountStatus(await client.request<AccountReadResult>('account/read', { refreshToken: true }));
    if (!status.signedIn || status.authType !== 'chatgpt') throw new Error('请先在设置中登录 ChatGPT Plus/Pro (Codex)');
    const threadParams: Record<string, unknown> = {
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      serviceName: CLIENT_INFO.name,
      developerInstructions: 'Only answer the user request. Do not call tools, inspect files, or modify the computer. Return only the JSON value required by the output schema.',
    };
    if (model.trim()) {
      const resolvedModel = resolveModel(await listModels(client), model);
      if (resolvedModel) threadParams.model = resolvedModel;
    }
    const thread = await client.request<ThreadStartResult>('thread/start', threadParams);
    const threadId = thread.thread?.id;
    if (!threadId) throw new Error('Codex 未返回线程 ID');
    const started = await client.request<TurnStartResult>('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly' },
      outputSchema,
    }, 60_000);
    const turnId = started.turn?.id;
    if (!turnId) throw new Error('Codex 未返回任务 ID');
    const completed = await client.waitForNotification<{ turn?: { id?: string; status?: string; error?: { message?: string } | null } }>(
      'turn/completed',
      (params) => params.turn?.id === turnId,
      5 * 60_000,
    );
    if (completed.turn?.status !== 'completed') throw new Error(completed.turn?.error?.message || `Codex 任务状态：${completed.turn?.status || '未知'}`);
    const item = await client.waitForNotification<{ turnId?: string; item?: { type?: string; text?: string; phase?: string | null } }>(
      'item/completed',
      (params) => params.turnId === turnId && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary',
      5 * 60_000,
    );
    const finalText = item.item?.text || '';
    if (!finalText.trim()) throw new Error('Codex 未返回内容');
    return finalText;
  } finally {
    client.close();
  }
}
