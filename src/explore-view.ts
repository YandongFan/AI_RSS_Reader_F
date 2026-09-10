import { Modal, Notice, Setting } from 'obsidian';
import type AiRssReaderPlugin from './main';
import { ARTICLE_STATUSES, articleStatus, isCurated, recommendationArticles, sortArticles } from './article-state';
import { recommendationFingerprint } from './recommendation';
import { renderArticlePreview } from './preview';
import { importFeedSources } from './feed-file';
import { decorateAction } from './action-icons';
import type { ArticleStatus, ArticleSort, RecommendationScore } from './types';

export class ExploreView {
  private section: 'reader' | 'feeds' | 'analytics' = 'reader';
  private status: ArticleStatus = 'unread';
  private query = '';
  private source = '';
  private limit = 100;
  private translated = false;
  private recommendationsOpen = true;
  constructor(private readonly plugin: AiRssReaderPlugin, private readonly refresh: () => void) {}

  private action(parent: HTMLElement, label: string, callback: () => void | Promise<void>, disabled = false): HTMLButtonElement {
    const button = parent.createEl('button', { text: label });
    decorateAction(button, label);
    button.disabled = disabled;
    button.addEventListener('click', () => {
      button.disabled = true;
      void Promise.resolve().then(callback).catch(error => new Notice(String(error))).finally(() => { button.disabled = disabled; });
    });
    return button;
  }

  render(root: HTMLElement): void {
    const tabs = root.createDiv({ cls: 'ai-rss-mode-tabs' });
    const sections = { reader: '文献阅读', feeds: '订阅管理', analytics: '兴趣分析' } as const;
    for (const [key, label] of Object.entries(sections)) {
      const button = this.action(tabs, label, () => { this.section = key as typeof this.section; this.refresh(); });
      button.classList.toggle('mod-cta', this.section === key);
    }
    if (this.section === 'feeds') { this.renderFeeds(root); return; }
    if (this.section === 'analytics') { this.renderAnalytics(root); return; }
    const articles = this.plugin.state.articles.filter(article => !isCurated(article));
    const metrics = root.createDiv({ cls: 'ai-rss-metrics' });
    for (const [key, label] of Object.entries(ARTICLE_STATUSES)) {
      const count = articles.filter(article => articleStatus(article) === key).length;
      const button = this.action(metrics, `${label} ${count}`, () => { this.status = key as ArticleStatus; this.limit = 100; this.refresh(); });
      button.classList.toggle('mod-cta', this.status === key);
    }
    const result = this.plugin.state.recommendations;
    const stale = !result || result.fingerprint !== recommendationFingerprint(recommendationArticles(this.plugin.state.articles), this.plugin.recommendationOptions);
    const scores = stale ? {} : result.scores;
    this.renderRecommendations(root, scores, stale);
    const filters = root.createDiv({ cls: 'ai-rss-filters' });
    const search = filters.createEl('input', { type: 'search', value: this.query, placeholder: '搜索标题、摘要、期刊或作者…', attr: { 'aria-label': '探索搜索' } });
    search.addEventListener('input', () => { this.query = search.value; this.limit = 100; this.renderCards(root, scores); });
    const source = filters.createEl('select', { attr: { 'aria-label': '探索期刊筛选' } });
    source.createEl('option', { value: '', text: '全部期刊' });
    [...new Set(articles.map(article => article.source))].sort().forEach(name => source.createEl('option', { value: name, text: name }));
    source.value = this.source;
    source.addEventListener('change', () => { this.source = source.value; this.limit = 100; this.renderCards(root, scores); });
    this.renderCards(root, scores);
  }

  private renderRecommendations(root: HTMLElement, scores: Record<string, RecommendationScore>, stale: boolean): void {
    const panel = root.createEl('details', { cls: 'ai-rss-recommendations' });
    panel.open = this.recommendationsOpen;
    panel.addEventListener('toggle', () => { this.recommendationsOpen = panel.open; });
    panel.createEl('summary', { text: '个性化推荐' });
    const unread = this.plugin.state.articles.filter(article => !isCurated(article) && articleStatus(article) === 'unread');
    const counts = ['high', 'pending', 'low', 'unscored'].map(tier => unread.filter(article => (scores[article.id]?.tier ?? 'unscored') === tier).length);
    const tiers = panel.createDiv({ cls: 'ai-rss-f-recommendation-tiers' });
    ['高相关', '待判断', '低相关', '未评分'].forEach((label, index) => {
      const card = tiers.createDiv(); card.createSpan({ text: label }); card.createEl('strong', { text: String(counts[index]) });
    });
    const model = this.plugin.state.recommendations;
    panel.createEl('p', { text: `精选文章 ${this.plugin.state.articles.filter(isCurated).length} 篇自动作为感兴趣正样本，不重复出现在探索篮子。` });
    panel.createEl('p', { text: model ? `正样本 ${model.positive} · 负样本 ${model.negative} · 验证准确率 ${model.accuracy == null ? '样本不足，未验证' : `${Math.round(model.accuracy * 100)}%`} · 阈值 ${model.lowThreshold ?? 30}/${model.highThreshold ?? 70} · ${new Date(model.updatedAt).toLocaleString()}${stale ? ' · 已过期，请更新推荐' : ''}` : '正样本（精选、感兴趣、归档）和负样本（隐藏、过期）各需至少 2 篇。' });
    const actions = panel.createDiv({ cls: 'ai-rss-table-toolbar' });
    this.action(actions, '更新关键词推荐', () => this.plugin.updateRecommendations());
    this.action(actions, '取消计算', () => this.plugin.cancelRecommendations());
    this.action(actions, '使用 LLM 复核待判断文章', () => this.plugin.reviewPendingRecommendations(), stale || !counts[1]);
    this.action(actions, '推荐关键词词表', () => new KeywordModal(this.plugin, this.refresh).open());
    const options = this.plugin.recommendationOptions;
    new Setting(panel).setName('研究兴趣（用于 LLM 复核）').addTextArea(input => input.setValue(options.userInterest).onChange(async value => { options.userInterest = value; await this.plugin.saveState(); }));
    for (const [key, label] of [['lowThreshold', '低阈值'], ['highThreshold', '高阈值']] as const) {
      new Setting(panel).setName(label).setDesc('留空使用自动校准；0–100，低阈值须小于高阈值。').addText(input => {
        input.inputEl.type = 'number'; input.inputEl.min = '0'; input.inputEl.max = '100'; input.setValue(options[key] == null ? '' : String(options[key]));
        input.inputEl.addEventListener('change', () => {
          const value = input.getValue().trim(); const number = value ? Number(value) : null;
          if (number !== null && (!Number.isFinite(number) || number < 0 || number > 100)) { new Notice('阈值必须介于 0 和 100'); return; }
          options[key] = number; void this.plugin.saveState().then(this.refresh);
        });
      });
    }
  }

  private renderCards(root: HTMLElement, scores: Record<string, RecommendationScore>): void {
    root.querySelector('.ai-rss-explore-list')?.remove();
    const list = root.createDiv({ cls: 'ai-rss-explore-list' });
    const query = this.query.trim().toLowerCase();
    const articles = sortArticles(this.plugin.state.articles.filter(article => !isCurated(article) && articleStatus(article) === this.status && (!this.source || article.source === this.source) && (!query || `${article.title} ${article.summary} ${article.source} ${article.authors ?? ''}`.toLowerCase().includes(query))), this.plugin.state.articleSort ?? 'relevance', scores);
    list.createEl('p', { text: `当前篮子共有 ${articles.length} 条，页面显示 ${Math.min(this.limit, articles.length)} 条。` });
    const toolbar = list.createDiv({ cls: 'ai-rss-table-toolbar' });
    this.action(toolbar, '刷新', this.refresh);
    this.action(toolbar, '撤回分类', () => this.plugin.undoClassification(), !this.plugin.canUndoStatus);
    if (this.status === 'unread') {
      this.action(toolbar, `隐藏剩余未读（${articles.length}）`, () => this.plugin.classifyArticles(articles, 'hidden'), !articles.length);
      const low = articles.filter(article => scores[article.id]?.tier === 'low');
      this.action(toolbar, `隐藏低相关（${low.length}）`, () => {
        if (this.plugin.state.recommendations?.fingerprint !== recommendationFingerprint(recommendationArticles(this.plugin.state.articles), this.plugin.recommendationOptions)) {
          new Notice('推荐已失效，请先更新关键词推荐'); this.refresh(); return;
        }
        return this.plugin.classifyArticles(low, 'hidden');
      }, !low.length);
    }
    this.action(toolbar, this.translated ? '显示原文标题' : '翻译标题', async () => {
      this.translated = !this.translated;
      if (this.translated) await this.plugin.translateTitles(articles.slice(0, this.limit));
      this.refresh();
    });
    for (const [key, label] of [['title', '按标题'], ['updated', '按更新时间'], ['journal', '按期刊'], ['relevance', '按相关度']] as const) {
      const button = this.action(toolbar, label, async () => { this.plugin.state.articleSort = key as ArticleSort; await this.plugin.saveState(); this.refresh(); });
      button.classList.toggle('mod-cta', (this.plugin.state.articleSort ?? 'relevance') === key);
    }
    for (const article of articles.slice(0, this.limit)) {
      const card = list.createEl('article', { cls: 'ai-rss-explore-card' });
      const content = card.createDiv();
      content.createEl('h3', { text: this.translated ? article.translatedTitle || article.title : article.title });
      content.createEl('p', { text: `${article.source} · ${(article.published || article.fetchedAt).slice(0, 10)}` });
      if (article.authors) content.createEl('p', { text: `作者：${article.authors}` });
      content.createEl('p', { text: article.summary, cls: 'ai-rss-explore-summary' });
      const score = scores[article.id];
      if (score) content.createEl('p', { text: `相关度 ${score.score}% · ${{ high: '高', pending: '待判断', low: '低' }[score.tier]} · ${score.terms.join('、')}${score.review?.tier ? ' · LLM 已复核' : score.review?.error ? ` · ${score.review.error}` : ''}` });
      const actions = content.createDiv({ cls: 'ai-rss-table-toolbar' });
      for (const [status, label] of Object.entries(ARTICLE_STATUSES).filter(([key]) => key !== 'expired' && key !== this.status)) this.action(actions, label, () => this.plugin.classifyArticles([article], status as ArticleStatus));
      const link = actions.createEl('a', { text: '打开原文', attr: { href: /^https?:\/\//i.test(article.link) ? article.link : '#', target: '_blank', rel: 'noopener noreferrer' } });
      link.addClass('ai-rss-external-link');
      decorateAction(link, '打开原文');
      this.action(actions, '保存笔记', () => this.plugin.saveArticleAsNote(article).then(() => undefined));
      if (article.imageUrl) renderArticlePreview(card.createDiv({ cls: 'ai-rss-explore-image' }), article, this.plugin.app);
    }
    if (articles.length > this.limit) this.action(list, '加载更多（100 条）', () => { this.limit += 100; this.renderCards(root, scores); });
    if (!articles.length) list.createEl('p', { text: '当前篮子没有符合条件的文章。精选文章仅显示在精选文章页签中。' });
  }

  private renderFeeds(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: 'ai-rss-table-toolbar' });
    this.action(toolbar, '更新所有订阅', () => this.plugin.refreshFeeds());
    this.action(toolbar, '检测所有 RSS 源', async () => { const results = await this.plugin.checkAndExportFeeds(); new Notice(`检测 ${results.length} 个源，正常 ${results.filter(r => r.ok).length} 个`); });
    this.action(toolbar, '从本地导入 RSS 链接', async () => { await this.plugin.importLocalFeeds(); this.refresh(); });
    const name = root.createEl('input', { placeholder: '订阅名称', attr: { 'aria-label': '订阅名称' } });
    const url = root.createEl('input', { placeholder: 'https://…/rss', attr: { 'aria-label': 'RSS 链接' } });
    this.action(root, '添加 RSS 源', async () => {
      this.plugin.state.settings.feeds = importFeedSources(JSON.stringify([{ name: name.value, url: url.value }]), this.plugin.state.settings.feeds, () => `feed-${crypto.randomUUID()}`);
      await this.plugin.saveState(); this.refresh();
    });
    for (const feed of this.plugin.state.settings.feeds) {
      const row = new Setting(root).setName(feed.name).setDesc(feed.url).addToggle(toggle => toggle.setValue(feed.enabled).onChange(async enabled => { feed.enabled = enabled; await this.plugin.saveState(); }));
      row.addButton(button => button.setButtonText('编辑').onClick(() => new EditFeedModal(this.plugin, feed.id, this.refresh).open()));
      row.addButton(button => button.setButtonText('移除订阅源').onClick(async () => { this.plugin.state.settings.feeds = this.plugin.state.settings.feeds.filter(item => item.id !== feed.id); await this.plugin.saveState(); this.refresh(); }));
    }
  }

  private renderAnalytics(root: HTMLElement): void {
    root.createEl('h3', { text: '兴趣分析' });
    const articles = recommendationArticles(this.plugin.state.articles);
    for (const [status, label] of Object.entries(ARTICLE_STATUSES)) root.createEl('p', { text: `${label}：${articles.filter(article => articleStatus(article) === status).length}` });
    root.createEl('p', { text: '感兴趣统计包含精选文章的虚拟正样本，不改变其实际阅读状态。' });
    const positive = this.plugin.state.recommendations?.keywords?.filter(keyword => keyword.weight > 0 && !this.plugin.recommendationOptions.disabledKeywords.includes(keyword.term)).sort((a, b) => b.weight - a.weight).slice(0, 30) ?? [];
    root.createEl('h4', { text: '正向兴趣关键词' });
    root.createEl('p', { text: positive.map(keyword => `${keyword.term} (${keyword.weight.toFixed(2)})`).join(' · ') || '更新关键词推荐后显示。' });
    const sources = new Map<string, number>();
    articles.filter(article => ['interested', 'archived'].includes(articleStatus(article))).forEach(article => sources.set(article.source, (sources.get(article.source) ?? 0) + 1));
    root.createEl('h4', { text: '感兴趣与归档的期刊分布' });
    [...sources].sort((a, b) => b[1] - a[1]).forEach(([source, count]) => root.createEl('p', { text: `${source}：${count}` }));
    this.action(root, '管理关键词', () => new KeywordModal(this.plugin, this.refresh).open());
  }
}

class KeywordModal extends Modal {
  constructor(private readonly plugin: AiRssReaderPlugin, private readonly refresh: () => void) { super(plugin.app); }
  onOpen(): void {
    this.contentEl.createEl('h3', { text: '推荐关键词词表' });
    this.contentEl.createEl('p', { text: '停用词不参与下次训练；修改后请更新推荐。' });
    const search = this.contentEl.createEl('input', { type: 'search', placeholder: '搜索关键词' });
    const list = this.contentEl.createDiv();
    const render = () => {
      list.empty();
      const keywords = this.plugin.state.recommendations?.keywords ?? [];
      const matches = [...keywords].filter(k => k.term.includes(search.value.toLowerCase())).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      list.createEl('p', { text: `共 ${matches.length} 个词，显示前 100 个；搜索可定位其余词。` });
      matches.slice(0, 100).forEach(keyword => new Setting(list).setName(keyword.term).setDesc(`权重 ${keyword.weight.toFixed(3)} · 正样本 ${keyword.positive} · 负样本 ${keyword.negative}`).addToggle(toggle => toggle.setValue(!this.plugin.recommendationOptions.disabledKeywords.includes(keyword.term)).onChange(async enabled => {
        const disabled = new Set(this.plugin.recommendationOptions.disabledKeywords);
        enabled ? disabled.delete(keyword.term) : disabled.add(keyword.term);
        this.plugin.recommendationOptions.disabledKeywords = [...disabled];
        await this.plugin.saveState(); this.refresh();
      })));
    };
    search.addEventListener('input', render); render();
  }
  onClose(): void { this.contentEl.empty(); }
}

class EditFeedModal extends Modal {
  constructor(private readonly plugin: AiRssReaderPlugin, private readonly id: string, private readonly refresh: () => void) { super(plugin.app); }
  onOpen(): void {
    const feed = this.plugin.state.settings.feeds.find(item => item.id === this.id);
    if (!feed) return;
    let name = feed.name; let url = feed.url;
    new Setting(this.contentEl).setName('名称').addText(input => input.setValue(name).onChange(value => { name = value; }));
    new Setting(this.contentEl).setName('RSS 链接').addText(input => input.setValue(url).onChange(value => { url = value; }));
    new Setting(this.contentEl).addButton(button => button.setButtonText('保存').onClick(async () => {
      try {
        const [updated] = importFeedSources(JSON.stringify([{ name, url, enabled: feed.enabled }]), [], () => feed.id);
        if (this.plugin.state.settings.feeds.some(item => item.id !== feed.id && item.url === updated.url)) throw new Error('该 RSS 链接已存在');
        Object.assign(feed, updated); await this.plugin.saveState(); this.close(); this.refresh();
      } catch (error) { new Notice(String(error)); }
    }));
  }
}
