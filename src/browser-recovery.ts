import { type App, type EventRef, type View, type WorkspaceLeaf } from 'obsidian';
import { browserArticleUrl, createCaptureBar } from './browser-page';
import { normalizeLiteratureSaveFolder } from './literature-input';

/** Recreate UI for restored tabs, without resuming downloads or writing plugin data. */
export function restoreBrowserCaptureControls(
  app: App,
  outputFolder: () => string,
  startCapture: (leaf: WorkspaceLeaf, folder: string) => Promise<unknown>,
): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const events: EventRef[] = [];
  const restored = new Set<WorkspaceLeaf>();
  const controls = new Map<WorkspaceLeaf, { view: View; banner?: HTMLElement }>();

  const refresh = (): void => {
    if (disposed) return;
    const open = new Set(app.workspace.getLeavesOfType('webviewer'));
    for (const leaf of restored) {
      if (!open.has(leaf)) {
        controls.get(leaf)?.banner?.remove();
        controls.delete(leaf);
        restored.delete(leaf);
        continue;
      }
      // Obsidian can restore background tabs as DeferredViews until selected.
      if (leaf.isDeferred || leaf.view.getViewType() !== 'webviewer') continue;
      const previous = controls.get(leaf);
      if (previous?.view === leaf.view) {
        if (previous.banner && !previous.banner.hasAttribute('data-ai-rss-restored')) previous.banner = undefined;
        if (previous.banner && !leaf.view.containerEl.contains(previous.banner) &&
            !leaf.view.containerEl.querySelector('.ai-rss-capture-bar')) leaf.view.containerEl.prepend(previous.banner);
        continue;
      }
      previous?.banner?.remove();
      const container = leaf.view.containerEl;
      if (!browserArticleUrl(leaf.view)) continue;
      const entry: { view: View; banner?: HTMLElement } = { view: leaf.view };
      controls.set(leaf, entry);
      // A normal save may already have attached its own active capture session.
      if (container.querySelector('.ai-rss-capture-bar')) continue;
      const { banner, start, cancel, folderInput, status } = createCaptureBar(container, outputFolder());
      banner.setAttribute('data-ai-rss-restored', '');
      entry.banner = banner;
      status.textContent = '抓取栏已恢复：确认当前论文正文加载完整后点击“开始抓取”。';
      cancel.addEventListener('click', () => { banner.remove(); entry.banner = undefined; });
      start.addEventListener('click', () => {
        if (disposed || start.disabled) return;
        let folder: string;
        try { folder = normalizeLiteratureSaveFolder(folderInput!.value); }
        catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
          folderInput?.focus();
          return;
        }
        start.disabled = true;
        banner.remove();
        entry.banner = undefined;
        // The existing capture flow owns validation, cancellation and saving after this click.
        void startCapture(leaf, folder).catch(error => {
          if (disposed || !app.workspace.getLeavesOfType('webviewer').includes(leaf) || leaf.view !== entry.view) return;
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('已取消')) return;
          start.disabled = false;
          status.textContent = `抓取未完成：${message}`;
          if (!container.querySelector('.ai-rss-capture-bar')) {
            container.prepend(banner);
            entry.banner = banner;
          }
        });
      });
    }
  };

  app.workspace.onLayoutReady(() => {
    if (disposed) return;
    app.workspace.getLeavesOfType('webviewer').forEach(leaf => restored.add(leaf));
    if (!restored.size) return;
    events.push(app.workspace.on('layout-change', refresh), app.workspace.on('active-leaf-change', refresh));
    // Deferred views and webviews may finish initializing after the layout event.
    timer = setInterval(refresh, 1500);
    refresh();
  });
  return () => {
    disposed = true;
    if (timer) clearInterval(timer);
    events.forEach(event => app.workspace.offref(event));
    controls.forEach(entry => entry.banner?.remove());
    controls.clear();
    restored.clear();
  };
}
