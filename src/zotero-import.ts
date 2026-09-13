import { App, Menu, Modal, Notice, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import type { RssArticle } from './types';
import { ZoteroImportJob, type ZoteroPackage } from './zotero-client';

const jobs = new WeakMap<App, Map<string, ZoteroImportJob>>();

function literatureNote(app: App, file: TAbstractFile, articles: RssArticle[]): TFile | undefined {
  const folder = file instanceof TFolder ? file : file.parent;
  if (!folder) return undefined;
  const notes = folder.children.filter((child): child is TFile => child instanceof TFile && child.extension === 'md');
  const candidates = notes.filter(note => {
    if (articles.some(article => article.savedPath === note.path)) return true;
    const metadata = app.metadataCache.getFileCache(note)?.frontmatter;
    const tags = metadata?.tags;
    return (Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : []).includes('ai-rss-reader');
  });
  // A shared folder cannot safely be copied as one literature package.
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function makeZoteroPackage(note: TFile, metadata: Record<string, unknown>, article?: RssArticle): ZoteroPackage {
  const text = (key: string, fallback = ''): string => typeof metadata[key] === 'string' || typeof metadata[key] === 'number' ? String(metadata[key]) : fallback;
  const authors = Array.isArray(metadata.authors) ? metadata.authors.filter((author): author is string => typeof author === 'string') : [];
  const title = text('title', article?.title || note.basename);
  const files: TFile[] = [];
  const visit = (folder: TFolder): void => {
    for (const child of folder.children) {
      if (child instanceof TFile && !child.name.startsWith('.') && !['md', 'bib'].includes(child.extension.toLowerCase())) files.push(child);
      else if (child instanceof TFolder && /supplement|peer.?review|补充|同行评审/i.test(child.name)) visit(child);
    }
  };
  if (note.parent) visit(note.parent);
  const mime: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv',
    zip: 'application/zip', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', mp4: 'video/mp4', html: 'text/html',
  };
  return { title, item: {
    itemType: 'journalArticle', title, DOI: text('doi'), url: text('source', article?.link || ''),
    publicationTitle: text('journal', article?.source || ''), date: text('published', text('year')),
    creators: authors.map(name => ({ creatorType: 'author', lastName: name, fieldMode: 1 })),
    tags: [{ tag: 'ai-rss-reader' }],
  }, files: files.sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ path: file.path, name: file.name, contentType: mime[file.extension.toLowerCase()] || 'application/octet-stream' })) };
}

export function addZoteroFileMenu(app: App, menu: Menu, file: TAbstractFile, articles: RssArticle[]): void {
  const note = literatureNote(app, file, articles);
  if (!note) return;
  menu.addItem(item => item.setTitle('导入到Zotero').setIcon('library').onClick(() => {
    let appJobs = jobs.get(app);
    if (!appJobs) { appJobs = new Map(); jobs.set(app, appJobs); }
    let job = appJobs.get(note.path);
    if (!job) {
      job = new ZoteroImportJob(makeZoteroPackage(note, app.metadataCache.getFileCache(note)?.frontmatter ?? {}, articles.find(article => article.savedPath === note.path)));
      appJobs.set(note.path, job);
    }
    new ZoteroImportModal(app, job).open();
  }));
}

class ZoteroImportModal extends Modal {
  constructor(app: App, private readonly job: ZoteroImportJob) { super(app); }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.createEl('h2', { text: '导入到Zotero' });
    root.createEl('p', { text: this.job.source.title });
    root.createEl('p', { text: '默认排除 .bib 和 .md 文件，不加入导入清单。' });
    root.createEl('p', { text: '将以下本地文件复制到同一条目下。请保持 Zotero 开启；分类加载失败时，检查“设置 → 高级 → 允许此计算机上的其他应用程序与 Zotero 通信”。' });
    const list = root.createEl('ul');
    for (const file of this.job.source.files) list.createEl('li', { text: file.name });
    const status = root.createEl('p', { text: '正在读取 Zotero 分类…' });
    status.style.whiteSpace = 'pre-wrap';
    const targetSelect = root.createEl('select', { attr: { 'aria-label': 'Zotero 目标分类' } });
    targetSelect.style.width = '100%';
    let running = false;
    let ready = false;
    const importButton = root.createEl('button', { text: '导入 / 补传未完成文件', cls: 'mod-cta' });
    importButton.disabled = true;
    const load = async (): Promise<void> => {
      if (running) return;
      ready = false;
      importButton.disabled = true;
      try {
        const selection = await this.job.targets();
        targetSelect.empty();
        for (const target of selection.targets.filter(item => item.filesEditable)) {
          targetSelect.createEl('option', { value: target.id, text: `${'　'.repeat(Math.min(12, Math.max(0, target.level)))}${target.name}` });
        }
        const current = selection.id ? `C${selection.id}` : `L${selection.libraryID}`;
        if (Array.from(targetSelect.options).some(option => option.value === current)) targetSelect.value = current;
        ready = targetSelect.options.length > 0 && this.job.source.files.length > 0;
        importButton.disabled = !ready;
        status.setText(ready ? `待导入 ${this.job.source.files.length} 个文件，已完成 ${this.job.uploaded.size} 个。重启插件后再次导入会创建新条目。` : '没有可写入的分类或没有本地文件');
      } catch (error) { status.setText(`无法连接 Zotero：${error instanceof Error ? error.message : String(error)}`); }
    };
    new Setting(root).addButton(button => button.setButtonText('刷新分类').onClick(() => void load()));
    importButton.addEventListener('click', async () => {
      if (running || !ready) return;
      running = true;
      importButton.disabled = true;
      targetSelect.disabled = true;
      try {
        await this.job.run(targetSelect.value, path => this.app.vault.adapter.readBinary(path), message => status.setText(message));
        new Notice('文献及本地文件已导入 Zotero');
      } catch (error) { status.setText(error instanceof Error ? error.message : String(error)); }
      finally { running = false; importButton.disabled = !ready; targetSelect.disabled = false; }
    });
    await load();
  }
}
