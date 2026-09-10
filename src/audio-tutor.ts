import { App, normalizePath, TFile } from 'obsidian';
import { createHash } from 'crypto';
import { generateText } from './ai';
import { ensureAudioTutorPrompts, readAudioTutorPrompt, type AudioTutorPromptName } from './audio-tutor-prompts';
import {
  findSupplementaryPdfs,
  formulaIndexMarkdown,
  inspectMinerUSource,
  loadMinerUTutorSource,
  type FormulaEntry,
  type MinerUTutorSource,
} from './audio-tutor-source';
import type { AiRssSettings, PluginState } from './types';

export type AudioTutorNoteKind = 'rough-reading' | 'formula-guide' | 'understanding' | 'review';
export type DerivationAction = 'derivation-exercise' | 'derivation-hint' | 'derivation-check';

interface AudioTutorHost {
  app: App;
  state: PluginState;
  saveState(): Promise<void>;
  processPdfWithMinerU(file: TFile, overrides?: Partial<AiRssSettings>): Promise<string[]>;
}

interface GenerateOptions {
  focus?: string;
}

const NOTE_SUFFIX: Record<AudioTutorNoteKind, string> = {
  'rough-reading': 'Rough-Reading',
  'formula-guide': 'Formula-Guide',
  understanding: 'Understanding',
  review: 'Review',
};

export class AudioTutorController {
  constructor(private readonly host: AudioTutorHost) {}

  async initialize(): Promise<void> {
    await ensureAudioTutorPrompts(this.host.app);
  }

  async ensureSource(input: TFile): Promise<MinerUTutorSource> {
    return this.ensureParsedSource(input);
  }

  private async ensureParsedSource(input: TFile): Promise<MinerUTutorSource> {
    const inspected = await inspectMinerUSource(this.host.app, input);
    if (inspected.missing.length === 0) return loadMinerUTutorSource(this.host.app, input);
    if (!inspected.pdfFile) throw new Error(`MinerU 数据不完整且找不到原始 PDF：${inspected.missing.join('、')}`);
    if (!this.host.state.settings.mineruToken.trim()) {
      throw new Error(`MinerU 数据不完整（${inspected.missing.join('、')}）。完整学习分析需要 MinerU 标准 API Token。`);
    }
    await this.host.processPdfWithMinerU(inspected.pdfFile, {
      mineruEnableFormula: true,
      mineruSaveMarkdown: true,
      mineruSaveContentListJson: true,
      mineruSaveLayoutJson: true,
      mineruSaveImages: true,
    });
    return loadMinerUTutorSource(this.host.app, inspected.pdfFile);
  }

  private async ensureSupplementarySources(source: MinerUTutorSource): Promise<MinerUTutorSource[]> {
    const supplements: MinerUTutorSource[] = [];
    for (const pdf of findSupplementaryPdfs(this.host.app, source.pdfFile)) {
      supplements.push(await this.ensureParsedSource(pdf));
    }
    return supplements;
  }

  async generateNote(input: TFile, kind: AudioTutorNoteKind, options: GenerateOptions = {}): Promise<TFile> {
    const source = await this.ensureSource(input);
    const supplementarySources = await this.ensureSupplementarySources(source);
    const paths = await this.ensureTutorFolder(source);
    const settings = this.host.state.settings;
    const companion = async (target: AudioTutorNoteKind): Promise<string> => {
      const file = fileAt(this.host.app, this.notePath(source, target));
      return file ? this.host.app.vault.cachedRead(file) : '';
    };
    const variables: Record<string, string | number> = {
      title: titleFromMarkdown(source.markdown) || source.paperName,
      outputLanguage: settings.audioTutorLanguage,
      learnerBackground: settings.audioTutorLearnerBackground,
      targetMinutes: settings.audioTutorTargetMinutes,
      focus: options.focus?.trim() || '未指定，按论文主线讲解',
      paperMarkdown: clipSource(source.markdown, 180_000),
      contentList: clipSource(source.contentListText, 60_000),
      layoutData: clipSource(source.layoutText, 60_000),
      formulaIndex: clipSource(formulaIndexMarkdown(source.formulas), 80_000),
      formulaGuide: kind === 'formula-guide' ? '' : clipSource(await companion('formula-guide'), 50_000),
      roughReading: kind === 'rough-reading' ? '' : clipSource(await companion('rough-reading'), 40_000),
      understandingNote: kind === 'understanding' ? '' : clipSource(await companion('understanding'), 40_000),
    };
    const basePrompt = await readAudioTutorPrompt(this.host.app, kind, variables);
    const prompt = appendSupplementaryContext(basePrompt, supplementarySources);
    const content = await generateText(settings.provider, prompt);
    if (kind === 'rough-reading' && containsDisplayMath(content)) throw new Error('粗读模型输出包含公式；请调整 rough-reading.md 后重试');
    const path = this.notePath(source, kind);
    const body = tutorNoteBody(kind, source, supplementarySources, content);
    const note = await upsertNote(this.host.app, path, body);
    await this.updateManifest(source, supplementarySources, paths.manifest, kind, prompt, content);
    return note;
  }

  async generateAll(input: TFile, options: GenerateOptions = {}, onProgress?: (message: string) => void): Promise<TFile[]> {
    const output: TFile[] = [];
    for (const kind of ['rough-reading', 'formula-guide', 'understanding', 'review'] as const) {
      onProgress?.(`正在生成${noteKindLabel(kind)}`);
      output.push(await this.generateNote(input, kind, options));
    }
    return output;
  }

  async runDerivation(
    input: TFile,
    action: DerivationAction,
    formula: FormulaEntry,
    data: { exercise?: string; currentDraft?: string; previousHints?: string; hintLevel?: number },
  ): Promise<string> {
    const source = await this.ensureSource(input);
    const settings = this.host.state.settings;
    const prompt = await readAudioTutorPrompt(this.host.app, action, {
      title: titleFromMarkdown(source.markdown) || source.paperName,
      outputLanguage: settings.audioTutorLanguage,
      learnerBackground: settings.audioTutorLearnerBackground,
      formula: `### ${formula.id}\n\n$$\n${formula.latex}\n$$`,
      formulaContext: formula.context,
      formulaIndex: clipSource(formulaIndexMarkdown(source.formulas), 60_000),
      exercise: data.exercise ?? '',
      currentDraft: data.currentDraft ?? '',
      previousHints: data.previousHints ?? '',
      hintLevel: data.hintLevel ?? 1,
    });
    return generateText(settings.provider, prompt);
  }

  async saveDerivationProgress(source: MinerUTutorSource, value: unknown): Promise<void> {
    const { folder } = await this.ensureTutorFolder(source);
    await this.host.app.vault.adapter.write(normalizePath(`${folder}/derivation-progress.json`), JSON.stringify(value, null, 2));
  }

  async readDerivationProgress(source: MinerUTutorSource): Promise<Record<string, unknown> | undefined> {
    const path = normalizePath(`${this.tutorFolder(source)}/derivation-progress.json`);
    if (!await this.host.app.vault.adapter.exists(path)) return undefined;
    try { return JSON.parse(await this.host.app.vault.adapter.read(path)) as Record<string, unknown>; }
    catch { return undefined; }
  }

  notePath(source: MinerUTutorSource, kind: AudioTutorNoteKind): string {
    return normalizePath(`${this.tutorFolder(source)}/${source.paperName}_${NOTE_SUFFIX[kind]}.md`);
  }

  tutorFolder(source: MinerUTutorSource): string {
    return normalizePath(`${source.folder}/${source.base}_Tutor`);
  }

  private async ensureTutorFolder(source: MinerUTutorSource): Promise<{ folder: string; manifest: string }> {
    const folder = this.tutorFolder(source);
    if (!await this.host.app.vault.adapter.exists(folder)) await this.host.app.vault.createFolder(folder);
    return { folder, manifest: normalizePath(`${folder}/tutor-manifest.json`) };
  }

  private async updateManifest(source: MinerUTutorSource, supplementarySources: MinerUTutorSource[], path: string, kind: AudioTutorNoteKind, prompt: string, content: string): Promise<void> {
    let manifest: Record<string, unknown> = {};
    if (await this.host.app.vault.adapter.exists(path)) {
      try { manifest = JSON.parse(await this.host.app.vault.adapter.read(path)) as Record<string, unknown>; } catch { /* Replace malformed generated manifest. */ }
    }
    const generated = typeof manifest.generated === 'object' && manifest.generated ? manifest.generated as Record<string, unknown> : {};
    generated[kind] = { generatedAt: new Date().toISOString(), promptHash: digest(prompt), outputHash: digest(content) };
    await this.host.app.vault.adapter.write(path, JSON.stringify({
      version: 2,
      sourcePdf: source.pdfFile.path,
      sourceMarkdown: source.markdownFile.path,
      supplementarySources: supplementarySources.map(item => ({
        pdf: item.pdfFile.path,
        markdown: item.markdownFile.path,
        contentList: item.contentListFile.path,
        layout: item.layoutFile.path,
      })),
      sourceHash: digest([source, ...supplementarySources]
        .map(item => `${item.pdfFile.path}\n${item.markdown}\n${item.contentListText}\n${item.layoutText}`)
        .join('\n\n')),
      generated,
    }, null, 2));
  }
}

export function containsDisplayMath(content: string): boolean {
  return /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\[[\s\S]*?\\\]|\\\([^\n]*?\\\)|\\begin\{(?:equation|align|gather)/.test(content);
}

export function clipSource(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const marker = '\n\n[内容过长，中间部分由插件截断；请以原始 MinerU 文件为准]\n\n';
  const half = Math.floor(Math.max(0, maximum - marker.length) / 2);
  if (half < 1) return value.slice(0, Math.max(0, maximum));
  return `${value.slice(0, half)}${marker}${value.slice(-half)}`;
}

export function appendSupplementaryContext(prompt: string, sources: MinerUTutorSource[]): string {
  if (sources.length === 0) return prompt;
  return `${prompt.trimEnd()}\n\n# Supplementary Material（补充材料）\n\n以下内容来自与主论文关联的补充材料。请将主文与补充材料明确区分；补充材料可用于补足方法、推导、数据和限制，但不得把补充材料独有的结论误写成主文结论。\n\n## Supplementary Markdown\n\n${formatSupplementaryField(sources, item => item.markdown, 120_000)}\n\n## Supplementary 内容列表\n\n${formatSupplementaryField(sources, item => item.contentListText, 40_000)}\n\n## Supplementary 布局数据\n\n${formatSupplementaryField(sources, item => item.layoutText, 40_000)}\n\n## Supplementary 公式索引\n\n${formatSupplementaryField(sources, item => formulaIndexMarkdown(item.formulas), 60_000)}\n`;
}

function formatSupplementaryField(sources: MinerUTutorSource[], select: (source: MinerUTutorSource) => string, maximum: number): string {
  const allowance = Math.max(1, Math.floor(maximum / sources.length) - 100);
  return sources.map(source => `### ${source.pdfFile.name}\n\n${clipSource(select(source), allowance)}`).join('\n\n');
}

function tutorNoteBody(kind: AudioTutorNoteKind, source: MinerUTutorSource, supplementarySources: MinerUTutorSource[], content: string): string {
  const supplementaryProperties = supplementarySources.length === 0 ? '' : [
    'supplementary-pdfs:',
    ...supplementarySources.map(item => `  - "[[${item.pdfFile.path.replace(/"/g, '\\"')}]]"`),
    'supplementary-markdown:',
    ...supplementarySources.map(item => `  - "[[${item.markdownFile.path.replace(/"/g, '\\"')}]]"`),
  ].join('\n') + '\n';
  const scope = supplementarySources.length > 0
    ? `主论文及 ${supplementarySources.length} 份补充材料的完整 MinerU 解析结果`
    : '完整 MinerU 解析结果';
  return `---\naudio-tutor: ${kind}\nsource-pdf: "[[${source.pdfFile.path.replace(/"/g, '\\"')}]]"\nsource-markdown: "[[${source.markdownFile.path.replace(/"/g, '\\"')}]]"\n${supplementaryProperties}generated: ${new Date().toISOString()}\n---\n\n> [!info] Audio Tutor\n> 本笔记由${scope}生成。事实、公式和页码请以对应的原始 PDF 为准。\n\n${content.trim()}\n`;
}

async function upsertNote(app: App, path: string, content: string): Promise<TFile> {
  const existing = fileAt(app, path);
  if (existing) {
    await app.vault.modify(existing, content);
    return existing;
  }
  return app.vault.create(path, content);
}

function fileAt(app: App, path: string): TFile | undefined {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function titleFromMarkdown(markdown: string): string {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function noteKindLabel(kind: AudioTutorNoteKind): string {
  return ({ 'rough-reading': '粗读讲稿', 'formula-guide': '公式详解', understanding: '理解检查', review: '复习笔记' } as const)[kind];
}
