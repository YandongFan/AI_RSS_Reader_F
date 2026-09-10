import { ItemView, MarkdownRenderer, Notice, Setting, TFile, WorkspaceLeaf } from 'obsidian';
import { AudioTutorController, type DerivationAction } from './audio-tutor';
import type { FormulaEntry, MinerUTutorSource } from './audio-tutor-source';

export const AUDIO_TUTOR_DERIVATION_VIEW = 'ai-rss-f-audio-tutor-derivation';

interface DerivationProgress {
  formulaId: string;
  exercise: string;
  draft: string;
  hints: string[];
  check: string;
  updatedAt: string;
}

export class AudioTutorDerivationView extends ItemView {
  private inputPath = '';
  private source?: MinerUTutorSource;
  private formula?: FormulaEntry;
  private progress: DerivationProgress = emptyProgress();
  private exerciseEl?: HTMLElement;
  private hintsEl?: HTMLElement;
  private checkEl?: HTMLElement;
  private draftEl?: HTMLTextAreaElement;
  private busy = false;

  constructor(leaf: WorkspaceLeaf, private readonly controller: AudioTutorController) {
    super(leaf);
  }

  getViewType(): string { return AUDIO_TUTOR_DERIVATION_VIEW; }
  getDisplayText(): string { return '推导练习'; }
  getIcon(): string { return 'square-function'; }

  async onOpen(): Promise<void> {
    await this.renderEmpty();
  }

  async setInput(file: TFile): Promise<void> {
    this.inputPath = file.path;
    await this.loadInput(file);
  }

  private async renderEmpty(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('ai-rss-derivation-view');
    this.contentEl.createEl('h2', { text: 'Theory Paper 推导练习' });
    this.contentEl.createEl('p', { text: '请从 PDF 或 *_MinerU.md 的右键菜单打开推导练习。', cls: 'setting-item-description' });
  }

  private async loadInput(file: TFile): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: `正在准备推导练习：${file.basename}` });
    try {
      this.source = await this.controller.ensureSource(file);
      const saved = await this.controller.readDerivationProgress(this.source);
      this.progress = normalizeProgress(saved);
      this.formula = this.source.formulas.find(item => item.id === this.progress.formulaId) ?? this.source.formulas[0];
      if (this.formula && !this.progress.formulaId) this.progress.formulaId = this.formula.id;
      await this.renderWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.contentEl.empty();
      this.contentEl.createEl('h2', { text: '推导练习无法打开' });
      this.contentEl.createEl('p', { text: message });
      new Notice(message, 10000);
    }
  }

  private async renderWorkspace(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.contentEl.empty();
    this.contentEl.addClass('ai-rss-derivation-view');
    const header = this.contentEl.createDiv({ cls: 'ai-rss-derivation-header' });
    header.createEl('h2', { text: `推导练习：${source.paperName}` });
    header.createEl('p', { text: `源：${source.markdownFile.path}`, cls: 'setting-item-description' });
    if (source.formulas.length === 0) {
      this.contentEl.createEl('p', { text: 'MinerU Markdown 中没有识别到独立公式块。请检查公式识别结果或重新解析 PDF。' });
      return;
    }

    new Setting(this.contentEl).setName('练习公式').addDropdown(dropdown => {
      source.formulas.forEach((formula, index) => dropdown.addOption(String(index), `${formula.id} · ${oneLine(formula.latex).slice(0, 80)}`));
      dropdown.setValue(String(Math.max(0, source.formulas.indexOf(this.formula!))));
      dropdown.onChange(value => void this.changeFormula(Number.parseInt(value, 10)));
    });

    const panes = this.contentEl.createDiv({ cls: 'ai-rss-derivation-panes' });
    const contextPane = panes.createDiv({ cls: 'ai-rss-derivation-pane ai-rss-derivation-context' });
    contextPane.createEl('h3', { text: '公式与上下文' });
    await MarkdownRenderer.render(this.app, formulaMarkdown(this.formula!), contextPane, source.markdownFile.path, this);

    const draftPane = panes.createDiv({ cls: 'ai-rss-derivation-pane ai-rss-derivation-draft' });
    draftPane.createEl('h3', { text: '推导草稿' });
    this.draftEl = draftPane.createEl('textarea', { cls: 'ai-rss-derivation-textarea' });
    this.draftEl.value = this.progress.draft;
    this.draftEl.placeholder = '使用 Markdown / LaTeX 写下你的推导……';
    this.draftEl.addEventListener('input', () => { this.progress.draft = this.draftEl?.value ?? ''; });
    this.draftEl.addEventListener('blur', () => void this.saveProgress());
    new Setting(draftPane)
      .addButton(button => button.setButtonText('保存草稿').onClick(() => void this.saveProgress(true)))
      .addButton(button => button.setButtonText('检查推导').setCta().onClick(() => void this.run('derivation-check')));

    const tutorPane = panes.createDiv({ cls: 'ai-rss-derivation-pane ai-rss-derivation-tutor' });
    tutorPane.createEl('h3', { text: 'AI 导师' });
    new Setting(tutorPane)
      .addButton(button => button.setButtonText('生成练习').setCta().onClick(() => void this.run('derivation-exercise')))
      .addButton(button => button.setButtonText('一级提示').onClick(() => void this.runHint(1)))
      .addButton(button => button.setButtonText('二级提示').onClick(() => void this.runHint(2)))
      .addButton(button => button.setButtonText('三级提示').onClick(() => void this.runHint(3)));
    this.exerciseEl = tutorPane.createDiv({ cls: 'ai-rss-derivation-result' });
    this.hintsEl = tutorPane.createDiv({ cls: 'ai-rss-derivation-result' });
    this.checkEl = tutorPane.createDiv({ cls: 'ai-rss-derivation-result' });
    await this.renderResults();
  }

  private async changeFormula(index: number): Promise<void> {
    if (!this.source?.formulas[index]) return;
    await this.saveProgress();
    this.formula = this.source.formulas[index];
    this.progress = { ...emptyProgress(), formulaId: this.formula.id };
    await this.renderWorkspace();
  }

  private async runHint(level: number): Promise<void> {
    await this.run('derivation-hint', level);
  }

  private async run(action: DerivationAction, hintLevel = 1): Promise<void> {
    if (this.busy || !this.source || !this.formula) return;
    if (action !== 'derivation-exercise' && !this.progress.exercise.trim()) {
      new Notice('请先生成练习');
      return;
    }
    this.busy = true;
    const notice = new Notice('AI 导师正在思考…', 0);
    try {
      this.progress.draft = this.draftEl?.value ?? this.progress.draft;
      const result = await this.controller.runDerivation(this.source.markdownFile, action, this.formula, {
        exercise: this.progress.exercise,
        currentDraft: this.progress.draft,
        previousHints: this.progress.hints.join('\n\n'),
        hintLevel,
      });
      if (action === 'derivation-exercise') {
        this.progress.exercise = result;
        this.progress.hints = [];
        this.progress.check = '';
      } else if (action === 'derivation-hint') this.progress.hints.push(`### ${hintLevel} 级提示\n\n${result}`);
      else this.progress.check = result;
      await this.saveProgress();
      await this.renderResults();
    } catch (error) {
      new Notice(`AI 导师失败：${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      notice.hide();
      this.busy = false;
    }
  }

  private async renderResults(): Promise<void> {
    if (!this.source) return;
    for (const [element, title, value] of [
      [this.exerciseEl, '练习', this.progress.exercise],
      [this.hintsEl, '提示', this.progress.hints.join('\n\n')],
      [this.checkEl, '检查结果', this.progress.check],
    ] as Array<[HTMLElement | undefined, string, string]>) {
      if (!element) continue;
      element.empty();
      if (!value.trim()) continue;
      element.createEl('h4', { text: title });
      await MarkdownRenderer.render(this.app, value, element, this.source.markdownFile.path, this);
    }
  }

  private async saveProgress(showNotice = false): Promise<void> {
    if (!this.source) return;
    this.progress.draft = this.draftEl?.value ?? this.progress.draft;
    this.progress.updatedAt = new Date().toISOString();
    await this.controller.saveDerivationProgress(this.source, this.progress);
    if (showNotice) new Notice('推导草稿已保存');
  }
}

function emptyProgress(): DerivationProgress {
  return { formulaId: '', exercise: '', draft: '', hints: [], check: '', updatedAt: '' };
}

function normalizeProgress(value: Record<string, unknown> | undefined): DerivationProgress {
  if (!value) return emptyProgress();
  return {
    formulaId: typeof value.formulaId === 'string' ? value.formulaId : '',
    exercise: typeof value.exercise === 'string' ? value.exercise : '',
    draft: typeof value.draft === 'string' ? value.draft : '',
    hints: Array.isArray(value.hints) ? value.hints.filter((item): item is string => typeof item === 'string') : [],
    check: typeof value.check === 'string' ? value.check : '',
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
  };
}

function formulaMarkdown(formula: FormulaEntry): string {
  return `## ${formula.id}\n\n$$\n${formula.latex}\n$$\n\n### 原文上下文\n\n${formula.context}`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
