import { request } from 'http';
import { randomUUID } from 'crypto';

export interface ZoteroTarget { id: string; name: string; level: number; filesEditable: boolean }
export interface ZoteroSelection {
  libraryID: number;
  id: number | null;
  targets: ZoteroTarget[];
}
export interface ZoteroResponse { status: number; text: string }
export type ZoteroRequest = (path: string, body: Buffer, contentType: string, headers?: Record<string, string>) => Promise<ZoteroResponse>;

// Fixed loopback endpoint: local file contents never go to a remote HTTP server.
export const requestZotero: ZoteroRequest = (path, body, contentType, headers = {}) => new Promise((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port: 23119, path: `/connector/${path}`, method: 'POST', headers: {
    'Content-Type': contentType, 'Content-Length': String(body.length),
    'X-Zotero-Connector-API-Version': '3', ...headers,
  } }, response => {
    const chunks: Buffer[] = [];
    response.on('data', chunk => chunks.push(Buffer.from(chunk)));
    response.on('error', reject);
    response.on('aborted', () => reject(new Error('Zotero 响应中断；请检查条目是否已经写入后再重试')));
    response.on('end', () => resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
  });
  req.setTimeout(120000, () => req.destroy(new Error('Zotero 请求超时；请检查条目是否已经写入后再重试')));
  req.on('error', reject);
  req.end(body);
});

export interface ZoteroFile { path: string; name: string; contentType: string }
export interface ZoteroPackage {
  title: string;
  item: Record<string, unknown>;
  files: ZoteroFile[];
}

export class ZoteroImportJob {
  private readonly sessionID = `ai-rss-${randomUUID()}`;
  private readonly parentID = 'ai-rss-parent';
  private created = false;
  private uncertainCreation = false;
  private busy = false;
  readonly uploaded = new Set<string>();

  constructor(readonly source: ZoteroPackage, private readonly send: ZoteroRequest = requestZotero) {}

  private async json(path: string, data: unknown, expected: number): Promise<string> {
    const response = await this.send(path, Buffer.from(JSON.stringify(data)), 'application/json');
    if (response.status !== expected) throw new Error(`Zotero ${path} 失败（HTTP ${response.status}）`);
    return response.text;
  }

  async targets(): Promise<ZoteroSelection> {
    const result = JSON.parse(await this.json('getSelectedCollection', {}, 200)) as ZoteroSelection;
    if (!Array.isArray(result.targets)) throw new Error('当前 Zotero 不支持分类列表，请更新 Zotero 后重试');
    return result;
  }

  async run(target: string, read: (path: string) => Promise<ArrayBuffer>, progress: (message: string) => void): Promise<void> {
    if (this.busy) throw new Error('此文献正在导入');
    if (this.uncertainCreation) throw new Error('上次创建条目的结果不确定，请先在 Zotero 中检查；重新启用插件后可发起新的导入');
    this.busy = true;
    try {
      const selection = await this.targets();
      if (!selection.targets.some(item => item.id === target && item.filesEditable)) throw new Error('目标分类不存在或不允许保存附件，请刷新分类');
      // Check files before creating the parent, so missing local files leave no empty item.
      for (const file of this.source.files) {
        if (!this.uploaded.has(file.path) && !(await read(file.path)).byteLength) throw new Error(`文件为空：${file.name}`);
      }
      if (!this.created) {
        progress('正在创建 Zotero 文献条目…');
        try {
          await this.json('saveItems', { sessionID: this.sessionID, items: [{ ...this.source.item, id: this.parentID, attachments: [] }] }, 201);
          this.created = true;
        } catch (error) {
          // Do not blindly repeat a write after a lost response.
          this.uncertainCreation = true;
          throw error;
        }
      }
      await this.json('updateSession', { sessionID: this.sessionID, target }, 200);
      const failures: string[] = [];
      for (const file of this.source.files) {
        if (this.uploaded.has(file.path)) continue;
        progress(`正在导入 ${this.uploaded.size + 1}/${this.source.files.length}：${file.name}`);
        try {
          const bytes = Buffer.from(await read(file.path));
          // URL supplies a filename only; saveAttachment consumes our byte stream, not this URL.
          const metadata = JSON.stringify({ sessionID: this.sessionID, parentItemID: this.parentID,
            title: file.name, url: `http://127.0.0.1:23119/ai-rss-local/${encodeURIComponent(file.name)}`,
          }).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
          const response = await this.send('saveAttachment', bytes, file.contentType, { 'X-Metadata': metadata });
          if (response.status !== 201) throw new Error(`HTTP ${response.status}`);
          this.uploaded.add(file.path);
        } catch (error) {
          failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length) throw new Error(`已导入 ${this.uploaded.size}/${this.source.files.length} 个文件。未完成：\n${failures.join('\n')}\n可补传未完成文件；若出现超时或中断，请先检查 Zotero，避免重复附件。`);
      progress(`导入完成：同一条目下共 ${this.uploaded.size} 个文件`);
    } finally { this.busy = false; }
  }
}
