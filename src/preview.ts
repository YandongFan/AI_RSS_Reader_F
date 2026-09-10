import { App, Modal, setTooltip } from 'obsidian';
import { safeImageUrl } from './article-image';
import type { RssArticle } from './types';

export function renderArticlePreview(container: HTMLElement, article: RssArticle, app: App): void {
  const url = safeImageUrl(article.imageUrl ?? '');
  if (!url) { container.textContent = '暂无预览图'; return; }
  const label = `放大查看 ${article.title} 的摘要图`;
  const button = container.createEl('button', { cls: 'ai-rss-preview-button', attr: { 'aria-label': label, title: label } });
  setTooltip(button, label, { placement: 'bottom' });
  button.createEl('img', { attr: { src: url, alt: article.title, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' } })
    .addEventListener('error', () => { container.textContent = '预览图加载失败'; });
  button.addEventListener('click', event => { event.stopPropagation(); new ArticleImageModal(app, url, article.title).open(); });
}

export class ArticleImageModal extends Modal {
  constructor(app: App, private readonly url: string, private readonly title: string) { super(app); }
  onOpen(): void {
    this.modalEl.addClass('ai-rss-f-image-modal');
    this.contentEl.createEl('h3', { text: '摘要图' });
    const img = this.contentEl.createEl('img', { cls: 'ai-rss-preview-full', attr: { src: this.url, alt: this.title, referrerpolicy: 'no-referrer' } });
    img.addEventListener('error', () => { img.remove(); this.contentEl.createEl('p', { text: '图片加载失败，请稍后重试。' }); });
  }
  onClose(): void { this.contentEl.empty(); }
}
