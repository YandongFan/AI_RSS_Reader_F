import { App, ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type AiRssReaderPlugin from './main';
import type { FetchProgress, RssArticle, TableColumnKey } from './types';
import { resizeTableColumns } from './table-columns';
import { normalizeLiteratureInputs, normalizeLiteratureSaveFolder } from './literature-input';
import { ARTICLE_STATUSES, articleStatus, sortArticles, isCurated } from './article-state';
import { ExploreView } from './explore-view';
import { renderArticlePreview } from './preview';
import { DEFAULT_STATE } from './defaults';
import { decorateAction } from './action-icons';
import type { ArticleStatus, ArticleSort, RecommendationScore } from './types';

export const AI_RSS_VIEW = 'ai-rss-reader-f-view';

type ReadFilter = ArticleStatus;

export class AiRssView extends ItemView {
  private explorer?: ExploreView;
  private query = '';
  private profile = '';
  private readFilter: ReadFilter = 'unread';
  private scores: Record<string, RecommendationScore> = {};
  private selectionAnchorId?: string;
  private readonly selectedIds = new Set<string>();
  private progress?: FetchProgress;
  private resizing?: { key: TableColumnKey; startX: number; startWidth: number; nextKey?: TableColumnKey; nextStartWidth?: number };

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiRssReaderPlugin) {
    super(leaf);
  }

  getViewType(): string { return AI_RSS_VIEW; }
  getDisplayText(): string { return 'AI RSS Reader F'; }
  getIcon(): string { return 'rss'; }

  async onOpen(): Promise<void> { this.render(); }

  setProgress(progress: FetchProgress): void {
    this.progress = progress;
    this.render();
  }

  render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass('ai-rss-root');
    this.renderHeader(root);
    const tabs = root.createDiv({ cls: 'ai-rss-mode-tabs', attr: { role: 'tablist', 'aria-label': '阅读模式' } });
    for (const [mode, label] of [['curated', '精选文章'], ['explore', '探索模式']] as const) {
      const active = (this.plugin.state.readerMode ?? 'curated') === mode;
      const tab = tabs.createEl('button', { text: label, cls: active ? 'mod-cta' : '', attr: { role: 'tab', 'aria-selected': String(active) } });
      decorateAction(tab, label);
      tab.addEventListener('click', () => { this.plugin.state.readerMode = mode; this.selectedIds.clear(); this.selectionAnchorId = undefined; void this.plugin.saveState(); this.render(); });
    }
    if (this.plugin.state.readerMode === 'explore') {
      this.explorer ??= new ExploreView(this.plugin, () => this.render());
      this.explorer.render(root); return;
    }
    this.scores = {};
    this.renderMetrics(root);
    this.renderFilters(root);
    this.renderArticles(root);
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv({ cls: 'ai-rss-header' });
    const identity = header.createDiv({ cls: 'ai-rss-identity' });
    const icon = identity.createSpan({ cls: 'ai-rss-logo' });
    setIcon(icon, 'rss');
    const titleWrap = identity.createDiv();
    titleWrap.createEl('h2', { text: 'AI RSS Reader F' });
    titleWrap.createDiv({ text: '把研究订阅变成可检索的 Obsidian 笔记', cls: 'ai-rss-subtitle' });

    const actions = header.createDiv({ cls: 'ai-rss-actions' });
    const openLink = actions.createEl('button', { text: '链接 / DOI', attr: { 'aria-label': '通过链接或 DOI 查看文献详情' } });
    openLink.addEventListener('click', () => this.plugin.openLiteratureInput());
    const settings = actions.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': '打开插件设置' } });
    setIcon(settings, 'settings');
    settings.addEventListener('click', () => {
      const setting = (this.app as typeof this.app & { setting: { open(): void; openTabById(id: string): void } }).setting;
      setting.open();
      setting.openTabById(this.plugin.manifest.id);
    });
    const refresh = actions.createEl('button', { text: '更新订阅', cls: 'mod-cta ai-rss-refresh' });
    const refreshIcon = refresh.createSpan();
    setIcon(refreshIcon, 'refresh-cw');
    refresh.prepend(refreshIcon);
    refresh.addEventListener('click', () => void this.plugin.refreshFeeds());

    if (this.progress) {
      const bar = root.createDiv({ cls: `ai-rss-progress ai-rss-progress-${this.progress.phase}` });
      const top = bar.createDiv({ cls: 'ai-rss-progress-label' });
      top.createSpan({ text: this.progress.message });
      if (this.progress.total > 0) top.createSpan({ text: `${this.progress.current}/${this.progress.total}` });
      const track = bar.createDiv({ cls: 'ai-rss-progress-track' });
      const fill = track.createDiv({ cls: 'ai-rss-progress-fill' });
      fill.style.width = `${Math.min(100, Math.round((this.progress.current / Math.max(1, this.progress.total)) * 100))}%`;
    }
  }

  private renderMetrics(root: HTMLElement): void {
    const articles = this.plugin.state.articles.filter(isCurated);
    const metrics = root.createDiv({ cls: 'ai-rss-metrics' });
    const icons = ['mail', 'star', 'archive', 'eye-off', 'clock'];
    Object.entries(ARTICLE_STATUSES).forEach(([key, label], index) => {
      this.metric(metrics, label, String(articles.filter(article => articleStatus(article) === key).length), icons[index], key);
    });
  }

  private metric(parent: HTMLElement, label: string, value: string, iconName: string, key: string): void {
    const card = parent.createEl('button', { cls: `ai-rss-metric${this.readFilter === key ? ' is-active' : ''}`, attr: { 'aria-pressed': String(this.readFilter === key) } });
    card.dataset.metric = key;
    card.addEventListener('click', () => {
      this.readFilter = key as ArticleStatus;
      this.selectedIds.clear();
      this.selectionAnchorId = undefined;
      this.render();
    });
    const icon = card.createSpan({ cls: 'ai-rss-metric-icon' });
    setIcon(icon, iconName);
    const copy = card.createDiv();
    copy.createDiv({ text: value, cls: 'ai-rss-metric-value' });
    copy.createDiv({ text: label, cls: 'ai-rss-metric-label' });
  }

  private renderFilters(root: HTMLElement): void {
    const filters = root.createDiv({ cls: 'ai-rss-filters' });
    const searchWrap = filters.createDiv({ cls: 'ai-rss-search' });
    const icon = searchWrap.createSpan();
    setIcon(icon, 'search');
    const search = searchWrap.createEl('input', { type: 'search', placeholder: '搜索标题、摘要或来源…', value: this.query });
    search.addEventListener('input', () => { this.query = search.value; this.selectionAnchorId = undefined; this.renderArticles(root, true); });

    const readSelect = filters.createEl('select');
    Object.entries(ARTICLE_STATUSES).forEach(([value, label]) => {
      const option = readSelect.createEl('option', { text: label, value });
      option.selected = value === this.readFilter;
    });
    readSelect.addEventListener('change', () => { this.readFilter = readSelect.value as ReadFilter; this.selectedIds.clear(); this.selectionAnchorId = undefined; this.render(); });

    const profileSelect = filters.createEl('select');
    profileSelect.createEl('option', { text: '全部方向', value: '' });
    this.plugin.state.settings.profiles.forEach((profile) => {
      const option = profileSelect.createEl('option', { text: profile.name, value: profile.name });
      option.selected = profile.name === this.profile;
    });
    profileSelect.addEventListener('change', () => { this.profile = profileSelect.value; this.selectionAnchorId = undefined; this.renderArticles(root, true); });
  }

  private renderArticles(root: HTMLElement, resetScroll = false): void {
    const previousTableScroll = resetScroll ? 0 : (root.querySelector('.ai-rss-table-shell') as HTMLElement | null)?.scrollTop ?? 0;
    root.querySelector('.ai-rss-list')?.remove();
    const list = root.createDiv({ cls: 'ai-rss-list' });
    const query = this.query.trim().toLowerCase();
    const articles = sortArticles(this.plugin.state.articles.filter((article) => {
      if (!isCurated(article)) return false;
      if (articleStatus(article) !== this.readFilter) return false;
      if (this.profile && !article.matchedProfiles.includes(this.profile)) return false;
      if (query && !`${article.title} ${article.summary} ${article.source}`.toLowerCase().includes(query)) return false;
      return true;
    }), this.plugin.state.articleSort ?? 'relevance', this.scores);
    const visibleIds = new Set(articles.map(article => article.id));
    this.selectedIds.forEach(id => { if (!visibleIds.has(id)) this.selectedIds.delete(id); });

    const listHeader = list.createDiv({ cls: 'ai-rss-list-header' });
    listHeader.createEl('h3', { text: '精选文章' });
    listHeader.createSpan({ text: `${articles.length} 篇` });
    const sorting = list.createDiv({ cls: 'ai-rss-table-toolbar' });
    const sorts: [ArticleSort, string][] = [['title', '按标题'], ['updated', '按更新时间'], ['journal', '按期刊'], ['relevance', '按相关度']];
    sorts.forEach(([key, label]) => {
      const button = sorting.createEl('button', { text: label, cls: (this.plugin.state.articleSort ?? 'relevance') === key ? 'mod-cta' : '' });
      button.addEventListener('click', () => {
        this.plugin.state.articleSort = key;
        this.selectionAnchorId = undefined;
        void this.plugin.saveState();
        this.renderArticles(root, true);
      });
    });
    sorting.createEl('button', { text: '重置列宽' }).addEventListener('click', () => {
      void this.plugin.saveTableColumnWidths({ ...DEFAULT_STATE.tableColumnWidths }).then(() => this.renderArticles(root, true));
    });
    const undo = sorting.createEl('button', { text: '撤回分类' });
    undo.disabled = !this.plugin.canUndoStatus;
    undo.addEventListener('click', () => void this.plugin.undoClassification());
    if (this.readFilter === 'unread') {
      const hide = sorting.createEl('button', { text: `隐藏剩余未读（${articles.length}）` });
      hide.disabled = articles.length === 0;
      hide.addEventListener('click', () => void this.plugin.classifyArticles(articles, 'hidden'));

    }
    if (articles.length === 0) {
      sorting.querySelectorAll<HTMLElement>('button').forEach(button => decorateAction(button));
      const empty = list.createDiv({ cls: 'ai-rss-empty' });
      const icon = empty.createSpan();
      setIcon(icon, 'inbox');
      empty.createEl('h3', { text: this.plugin.state.articles.length ? '没有符合筛选条件的文章' : '还没有文章' });
      empty.createEl('p', { text: this.plugin.state.articles.length ? '尝试调整搜索或筛选条件。' : '配置 RSS 源和 AI 模型后，点击“更新订阅”。' });
      return;
    }
    const tableShell = list.createDiv({ cls: 'ai-rss-table-shell' });
    const table = tableShell.createEl('table', { cls: 'ai-rss-table' });
    const colgroup = table.createEl('colgroup');
    const columnKeys: TableColumnKey[] = ['select', 'title', 'source', 'profiles', 'reason', 'date', 'preview'];
    columnKeys.forEach((key) => {
      const col = colgroup.createEl('col');
      col.dataset.column = key;
      col.style.width = `${this.columnWidth(key) / columnKeys.reduce((sum, column) => sum + this.columnWidth(column), 0) * 100}%`;
    });
    const headerRow = table.createTHead().insertRow();
    const selectHeader = document.createElement('th');
    selectHeader.className = 'ai-rss-select-cell';
    const selectAllCheckbox = selectHeader.createEl('input', { type: 'checkbox', attr: { 'aria-label': '选择筛选结果中的全部文章' } });
    selectAllCheckbox.checked = articles.every((article) => this.selectedIds.has(article.id));
    selectAllCheckbox.indeterminate = articles.some((article) => this.selectedIds.has(article.id)) && !selectAllCheckbox.checked;
    selectAllCheckbox.addEventListener('change', () => {
      articles.forEach((article) => selectAllCheckbox.checked ? this.selectedIds.add(article.id) : this.selectedIds.delete(article.id));
      this.selectionAnchorId = undefined;
      this.renderArticles(root);
    });
    headerRow.appendChild(selectHeader);
    this.addResizeHandle(selectHeader, 'select', table, columnKeys);
    ['标题', '期刊', '研究方向', '推荐说明', '更新时间', '预览图'].forEach((label, index) => {
      const cell = document.createElement('th');
      cell.textContent = label;
      this.addResizeHandle(cell, columnKeys[index + 1], table, columnKeys);
      headerRow.appendChild(cell);
    });
    const body = table.createTBody();
    articles.forEach((article) => this.renderTableRow(body, article, root, articles));

    const toolbar = list.createDiv({ cls: 'ai-rss-table-toolbar' });
    const selectedCount = this.selectedArticles().length;
    Object.entries(ARTICLE_STATUSES).filter(([status]) => status !== 'expired').forEach(([status, label]) => {
      const button = toolbar.createEl('button', { text: status === 'unread' ? '恢复未读' : label });
      button.disabled = selectedCount === 0;
      button.addEventListener('click', () => {
        const selected = this.selectedArticles();
        this.selectedIds.clear();
        void this.plugin.classifyArticles(selected, status as ArticleStatus);
      });
    });
    const refresh = toolbar.createEl('button', { text: '刷新列表' });
    refresh.addEventListener('click', () => this.render());
    const analyze = toolbar.createEl('button', { text: '重新分析' });
    analyze.disabled = selectedCount === 0;
    analyze.addEventListener('click', () => void this.reanalyzeSelected());
    const selectAll = toolbar.createEl('button', { text: '全选' });
    selectAll.addEventListener('click', () => {
      const allSelected = articles.length > 0 && articles.every((article) => this.selectedIds.has(article.id));
      articles.forEach((article) => allSelected ? this.selectedIds.delete(article.id) : this.selectedIds.add(article.id));
      this.selectionAnchorId = undefined;
      this.renderArticles(root);
    });
    const markRead = toolbar.createEl('button', { text: '标记已读' });
    markRead.disabled = selectedCount === 0;
    markRead.addEventListener('click', () => void this.setSelectedRead(true));
    const markUnread = toolbar.createEl('button', { text: '标记未读' });
    markUnread.disabled = selectedCount === 0;
    markUnread.addEventListener('click', () => void this.setSelectedRead(false));
    const saveNotes = toolbar.createEl('button', { text: '保存笔记' });
    saveNotes.disabled = selectedCount === 0;
    saveNotes.addEventListener('click', () => this.openBatchSaveFolder());
    toolbar.createSpan({ text: selectedCount > 0 ? `已选 ${selectedCount} 篇` : '勾选文章，Shift + 左键连续选择', cls: 'ai-rss-selection-count' });
    list.querySelectorAll<HTMLElement>('.ai-rss-table-toolbar button').forEach(button => decorateAction(button));
    tableShell.scrollTop = previousTableScroll;
  }

  private columnWidth(key: TableColumnKey): number {
    return this.plugin.state.tableColumnWidths?.[key] ?? 100;
  }

  private addResizeHandle(cell: HTMLElement, key: TableColumnKey, table: HTMLTableElement, keys: TableColumnKey[]): void {
    const handle = document.createElement('span');
    handle.className = 'ai-rss-column-resizer';
    handle.setAttribute('aria-label', `调整${key}列宽度`);
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const index = keys.indexOf(key);
      const nextKey = keys[index + 1];
      this.resizing = {
        key,
        startX: event.clientX,
        startWidth: this.columnWidth(key),
        nextKey,
        nextStartWidth: nextKey ? this.columnWidth(nextKey) : undefined,
      };
      const move = (moveEvent: MouseEvent) => this.resizeColumns(moveEvent, table);
      const end = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', end);
        if (this.resizing) void this.plugin.saveTableColumnWidths(this.plugin.state.tableColumnWidths);
        this.resizing = undefined;
        document.body.removeClass('ai-rss-resizing-columns');
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', end);
      document.body.addClass('ai-rss-resizing-columns');
    });
    cell.appendChild(handle);
  }

  private resizeColumns(event: MouseEvent, table: HTMLTableElement): void {
    const resizing = this.resizing;
    if (!resizing) return;
    const totalWidth = Object.values(this.plugin.state.tableColumnWidths).reduce((sum, width) => sum + width, 0);
    const delta = (event.clientX - resizing.startX) * totalWidth / table.getBoundingClientRect().width;
    this.plugin.state.tableColumnWidths = resizeTableColumns(
      { ...this.plugin.state.tableColumnWidths, [resizing.key]: resizing.startWidth,
        ...(resizing.nextKey ? { [resizing.nextKey]: resizing.nextStartWidth! } : {}) },
      resizing.key,
      resizing.nextKey,
      delta,
    );
    table.querySelectorAll<HTMLTableColElement>('col').forEach((col) => {
      const column = col.dataset.column as TableColumnKey | undefined;
      if (column) col.style.width = `${this.columnWidth(column) / Object.values(this.plugin.state.tableColumnWidths).reduce((sum, width) => sum + width, 0) * 100}%`;
    });
  }

  private selectArticle(article: RssArticle, articles: RssArticle[], selected: boolean, range: boolean, root: HTMLElement): void {
    const anchor = articles.findIndex((item) => item.id === this.selectionAnchorId);
    const target = articles.findIndex((item) => item.id === article.id);
    const affected = range && anchor >= 0
      ? articles.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)
      : [article];
    affected.forEach((item) => selected ? this.selectedIds.add(item.id) : this.selectedIds.delete(item.id));
    if (!range || anchor < 0) this.selectionAnchorId = article.id;
    this.renderArticles(root);
  }

  private renderTableRow(body: HTMLTableSectionElement, article: RssArticle, root: HTMLElement, articles: RssArticle[]): void {
    const row = body.insertRow();
    row.dataset.articleId = article.id;
    row.className = `${article.read ? 'is-read ' : ''}${this.selectedIds.has(article.id) ? 'is-selected' : ''}`.trim();
    const selectCell = row.insertCell();
    selectCell.className = 'ai-rss-select-cell';
    const checkbox = selectCell.createEl('input', { type: 'checkbox', attr: { 'aria-label': `选择 ${article.title}` } });
    checkbox.checked = this.selectedIds.has(article.id);
    checkbox.addEventListener('click', (event) => {
      event.stopPropagation();
      this.selectArticle(article, articles, checkbox.checked, event.shiftKey, root);
    });

    const titleCell = row.insertCell();
    titleCell.className = 'ai-rss-title-cell';
    const title = titleCell.createEl('button', { text: article.title, cls: 'ai-rss-title-link' });
    title.title = article.title;
    title.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!article.read) void this.plugin.markArticleRead(article);
      void this.plugin.saveArticleAsNote(article).catch((error) => new Notice(`保存笔记失败：${String(error)}`, 10000));
    });
    if (!article.read) titleCell.createSpan({ text: '未读', cls: 'ai-rss-unread-dot' });

    const source = row.insertCell();
    source.textContent = article.source;
    source.title = article.source;
    const profiles = row.insertCell();
    profiles.textContent = article.matchedProfiles.join('、') || '未推荐';
    profiles.title = profiles.textContent;
    const reason = row.insertCell();
    const preferred = article.matchedProfiles[0] ?? Object.keys(article.analysis)[0];
    reason.textContent = preferred ? article.analysis[preferred]?.reason || '暂无推荐理由' : '暂无推荐理由';
    reason.title = reason.textContent;
    const score = this.scores?.[article.id];
    if (score) reason.createEl('small', { text: `关键词相关度 ${score.score}%（${{ high: '高', pending: '待判断', low: '低' }[score.tier]}） · ${score.terms.join('、')}`, cls: 'ai-rss-recommendation-score' });
    const date = row.insertCell();
    date.textContent = this.formatDate(article.updatedAt || article.fetchedAt || article.published);
    const preview = row.insertCell();
    renderArticlePreview(preview, article, this.app);

    row.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('input')) return;
      this.selectArticle(article, articles, true, event.shiftKey, root);
    });
    row.addEventListener('mousedown', (event) => {
      if (event.shiftKey) event.preventDefault();
    });
  }

  private selectedArticles(): RssArticle[] {
    return this.plugin.state.articles.filter((article) => this.selectedIds.has(article.id));
  }

  private async setSelectedRead(read: boolean): Promise<void> {
    const selected = this.selectedArticles();
    this.selectedIds.clear();
    await this.plugin.setArticlesRead(selected, read);
  }

  private async reanalyzeSelected(): Promise<void> {
    const selected = this.selectedArticles();
    if (selected.length === 0) return;
    await this.plugin.reanalyzeArticles(selected);
    this.selectedIds.clear();
    this.render();
  }

  private openBatchSaveFolder(): void {
    new SaveFolderModal(this.plugin, '批量保存笔记', folder => this.saveSelectedNotes(folder)).open();
  }

  private async saveSelectedNotes(outputFolder?: string): Promise<void> {
    const selected = this.selectedArticles();
    this.selectedIds.clear();
    const result = await this.plugin.saveArticlesAsNotes(selected, outputFolder);
    this.render();
    if (result.failures.length === 0) {
      new Notice(`已保存 ${selected.length} 篇笔记`);
      return;
    }
    const first = result.failures[0];
    new Notice(`批量保存完成：成功 ${result.saved.length} 篇，失败 ${result.failures.length} 篇。首个失败：${first.article.title}：${first.reason}`, 12000);
  }

  articleBecameRead(_articleId: string): void {
    this.render();
  }

  private formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '未知';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}

class SaveFolderModal extends Modal {
  constructor(
    private readonly plugin: AiRssReaderPlugin,
    private readonly heading: string,
    private readonly submitSave: (folder: string) => Promise<void>,
  ) { super(plugin.app); }

  onOpen(): void {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: '设置本次保存的根目录（Obsidian 库内相对路径）。之后仍会按“来源 / 文献文件夹”建立子目录。' });
    const form = this.contentEl.createEl('form');
    const label = form.createEl('label', { cls: 'ai-rss-save-folder-field' });
    label.createSpan({ text: '保存到' });
    const input = label.createEl('input', {
      type: 'text', value: this.plugin.preferredLiteratureSaveFolder(),
      placeholder: 'AI RSS Reader', attr: { 'aria-label': '文献保存根目录' },
    });
    const error = form.createEl('p', { attr: { role: 'alert' } });
    error.style.color = 'var(--text-error)';
    const actions = form.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: '取消', type: 'button' });
    cancel.addEventListener('click', () => this.close());
    const submit = actions.createEl('button', { text: '开始保存', type: 'submit', cls: 'mod-cta' });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submit.disabled) return;
      let folder: string;
      try { folder = normalizeLiteratureSaveFolder(input.value); }
      catch (reason) {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        input.focus();
        return;
      }
      submit.disabled = true;
      this.close();
      void this.submitSave(folder).catch(reason => new Notice(`批量保存失败：${String(reason)}`, 10000));
    });
    input.focus();
    input.select();
  }

  onClose(): void { this.contentEl.empty(); }
}

export class LiteratureInputModal extends Modal {
  constructor(private readonly plugin: AiRssReaderPlugin) { super(plugin.app); }

  onOpen(): void {
    this.titleEl.setText('通过链接 / DOI 导入文献');
    this.contentEl.createEl('p', { text: '输入文献链接或 DOI。每行一个；多条会复用批量自动抓取流程。' });
    const form = this.contentEl.createEl('form');
    const input = form.createEl('textarea', {
      placeholder: 'https://… 或 10.1038/nature12373\n每行一条',
      attr: { 'aria-label': '文献链接或 DOI', autocomplete: 'off' },
    });
    input.style.width = '100%';
    input.rows = 7;
    const folderLabel = form.createEl('label', { cls: 'ai-rss-save-folder-field' });
    folderLabel.createSpan({ text: '保存到' });
    const folderInput = folderLabel.createEl('input', {
      type: 'text', value: this.plugin.preferredLiteratureSaveFolder(),
      placeholder: 'AI RSS Reader', attr: { 'aria-label': '文献保存根目录' },
    });
    const error = form.createEl('p', { attr: { role: 'alert' } });
    error.style.color = 'var(--text-error)';
    const actions = form.createDiv({ cls: 'modal-button-container' });
    const cancel = actions.createEl('button', { text: '取消', type: 'button' });
    cancel.addEventListener('click', () => this.close());
    const submit = actions.createEl('button', { text: '导入', type: 'submit', cls: 'mod-cta' });
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (submit.disabled) return;
      const value = input.value;
      let outputFolder: string;
      try {
        normalizeLiteratureInputs(value);
        outputFolder = normalizeLiteratureSaveFolder(folderInput.value);
      }
      catch (reason) {
        error.setText(reason instanceof Error ? reason.message : String(reason));
        input.focus();
        return;
      }
      submit.disabled = true;
      this.close();
      void this.plugin.openLiteratureLinks(value, outputFolder).then((result) => {
        if (result.failures.length === 0) {
          if (result.saved.length > 1) new Notice(`批量导入完成：已保存 ${result.saved.length} 篇笔记`);
          return;
        }
        const first = result.failures[0];
        new Notice(`批量导入完成：成功 ${result.saved.length} 篇，失败 ${result.failures.length} 篇。首个失败：${first.article.title}：${first.reason}`, 12000);
      }).catch(reason => new Notice(`保存笔记失败：${String(reason)}`, 10000));
    });
    input.focus();
  }

  onClose(): void { this.contentEl.empty(); }
}
