import { getIcon, setIcon } from 'obsidian';

const ACTION_ICONS: Record<string, string> = {
  '刷新': 'refresh-cw', '更新所有订阅': 'refresh-cw', '撤回': 'undo-2',
  '隐藏': 'eye-off', '已隐藏': 'eye-off', '翻译标题': 'languages', '显示原文标题': 'languages',
  '按标题': 'arrow-down-a-z', '按更新时间': 'clock-3', '按期刊': 'book-open', '按相关度': 'sparkles',
  '更新关键词推荐': 'sparkles', '使用 LLM': 'bot', '推荐关键词词表': 'list-tree', '管理关键词': 'list-tree',
  '取消计算': 'square', '感兴趣': 'star', '归档': 'archive', '未读': 'inbox', '恢复未读': 'inbox', '已过期': 'clock-3',
  '打开原文': 'external-link', '保存笔记': 'save', '重新分析': 'sparkles', '全选': 'list-checks',
  '标记已读': 'check-check', '标记未读': 'inbox', '重置列宽': 'columns-3',
  '检测所有 RSS 源': 'activity', '从本地导入 RSS 链接': 'download', '添加 RSS 源': 'plus', '加载更多': 'chevrons-down',
  '精选文章': 'list-filter', '探索模式': 'compass', '文献阅读': 'book-open', '订阅管理': 'rss', '兴趣分析': 'chart-column',
};

/** Keep the visible label intact; the icon is decorative for screen readers. */
export function decorateAction(element: HTMLElement, label = element.textContent ?? ''): void {
  const icon = Object.entries(ACTION_ICONS).find(([prefix]) => label.startsWith(prefix))?.[1];
  if (!icon || element.querySelector('.ai-rss-f-action-icon')) return;
  const span = element.createSpan({ cls: 'ai-rss-f-action-icon', attr: { 'aria-hidden': 'true' } });
  const availableIcon = icon === 'arrow-down-a-z' && !getIcon(icon) ? 'arrow-down-az' : icon;
  setIcon(span, availableIcon);
  element.prepend(span);
  element.addClass('ai-rss-f-action');
}
