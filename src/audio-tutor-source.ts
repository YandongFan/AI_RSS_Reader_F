import { App, normalizePath, TFile } from 'obsidian';

export interface FormulaEntry {
  id: string;
  latex: string;
  context: string;
  offset: number;
}

export interface MinerUTutorSource {
  pdfFile: TFile;
  markdownFile: TFile;
  contentListFile: TFile;
  layoutFile: TFile;
  folder: string;
  base: string;
  paperName: string;
  markdown: string;
  contentListText: string;
  layoutText: string;
  formulas: FormulaEntry[];
  imagePaths: string[];
}

export interface MinerUSourceInspection {
  pdfFile?: TFile;
  markdownFile?: TFile;
  contentListFile?: TFile;
  layoutFile?: TFile;
  folder?: string;
  base?: string;
  paperName?: string;
  missing: string[];
}

export function isMinerUMarkdown(file: TFile | null | undefined): file is TFile {
  return Boolean(file && file.extension.toLowerCase() === 'md' && /_MinerU$/i.test(file.basename));
}

export function isAudioTutorInput(file: TFile | null | undefined): file is TFile {
  return Boolean(file && (file.extension.toLowerCase() === 'pdf' || isMinerUMarkdown(file)));
}

/** Find supplementary PDFs saved by the literature capture flow for a main paper. */
export function findSupplementaryPdfs(app: App, mainPdf: TFile): TFile[] {
  const parentPath = mainPdf.parent?.path ?? '';
  const prefix = `${mainPdf.basename}-supplementary-`.toLowerCase();
  return app.vault.getFiles()
    .filter(file => file.extension.toLowerCase() === 'pdf'
      && (file.parent?.path ?? '') === parentPath
      && file.basename.toLowerCase().startsWith(prefix)
      && /^\d+$/.test(file.basename.slice(prefix.length)))
    .sort((left, right) => supplementaryIndex(left, prefix) - supplementaryIndex(right, prefix)
      || left.path.localeCompare(right.path));
}

function fileAt(app: App, path: string): TFile | undefined {
  const found = app.vault.getAbstractFileByPath(normalizePath(path));
  return found instanceof TFile ? found : undefined;
}

function findPdf(app: App, parentPath: string, paperName: string): TFile | undefined {
  const expected = normalizePath([parentPath, `${paperName}.pdf`].filter(Boolean).join('/')).toLowerCase();
  return app.vault.getFiles().find(file => file.path.toLowerCase() === expected);
}

export function expectedMinerUPaths(pdfFile: Pick<TFile, 'parent' | 'basename'>): { folder: string; base: string; markdown: string; contentList: string; layout: string } {
  const folder = normalizePath([pdfFile.parent?.path, 'Miner_U'].filter(Boolean).join('/'));
  const base = `${pdfFile.basename}_MinerU`;
  return {
    folder,
    base,
    markdown: normalizePath(`${folder}/${base}.md`),
    contentList: normalizePath(`${folder}/${base}_content_list.json`),
    layout: normalizePath(`${folder}/${base}_layout.json`),
  };
}

export async function inspectMinerUSource(app: App, input: TFile): Promise<MinerUSourceInspection> {
  let pdfFile: TFile | undefined;
  let folder = '';
  let base = '';
  let paperName = '';
  if (input.extension.toLowerCase() === 'pdf') {
    pdfFile = input;
    paperName = input.basename;
    ({ folder, base } = expectedMinerUPaths(input));
  } else if (isMinerUMarkdown(input)) {
    folder = input.parent?.path ?? '';
    base = input.basename;
    paperName = base.replace(/_MinerU$/i, '');
    pdfFile = findPdf(app, input.parent?.parent?.path ?? '', paperName);
  }

  const missing: string[] = [];
  if (!folder || !base) return { missing: ['请选择原始 PDF 或 *_MinerU.md'] };
  const markdownFile = fileAt(app, `${folder}/${base}.md`);
  const contentListFile = fileAt(app, `${folder}/${base}_content_list.json`);
  const layoutFile = fileAt(app, `${folder}/${base}_layout.json`);
  if (!pdfFile) missing.push('原始 PDF');
  if (!markdownFile) missing.push('MinerU Markdown');
  if (!contentListFile) missing.push('content_list JSON');
  if (!layoutFile) missing.push('layout JSON');

  if (markdownFile) {
    const markdown = await app.vault.cachedRead(markdownFile);
    if (!markdown.trim()) missing.push('非空 MinerU Markdown');
    for (const imagePath of extractMarkdownImagePaths(markdown)) {
      const resolved = normalizePath(`${folder}/${decodeSafe(imagePath)}`);
      if (!fileAt(app, resolved)) missing.push(`图片 ${imagePath}`);
    }
  }
  for (const [file, label] of [[contentListFile, 'content_list JSON'], [layoutFile, 'layout JSON']] as const) {
    if (!file) continue;
    try { JSON.parse(await app.vault.cachedRead(file)); }
    catch { missing.push(`可解析的 ${label}`); }
  }
  return { pdfFile, markdownFile, contentListFile, layoutFile, folder, base, paperName, missing: [...new Set(missing)] };
}

export async function loadMinerUTutorSource(app: App, input: TFile): Promise<MinerUTutorSource> {
  const inspected = await inspectMinerUSource(app, input);
  if (inspected.missing.length > 0 || !inspected.pdfFile || !inspected.markdownFile || !inspected.contentListFile || !inspected.layoutFile || !inspected.folder || !inspected.base || !inspected.paperName) {
    throw new Error(`MinerU 数据不完整：${inspected.missing.join('、')}`);
  }
  const [markdown, contentListText, layoutText] = await Promise.all([
    app.vault.cachedRead(inspected.markdownFile),
    app.vault.cachedRead(inspected.contentListFile),
    app.vault.cachedRead(inspected.layoutFile),
  ]);
  return {
    pdfFile: inspected.pdfFile,
    markdownFile: inspected.markdownFile,
    contentListFile: inspected.contentListFile,
    layoutFile: inspected.layoutFile,
    folder: inspected.folder,
    base: inspected.base,
    paperName: inspected.paperName,
    markdown,
    contentListText,
    layoutText,
    formulas: extractFormulaEntries(markdown),
    imagePaths: extractMarkdownImagePaths(markdown),
  };
}

export function extractMarkdownImagePaths(markdown: string): string[] {
  const paths = [
    ...[...markdown.matchAll(/!\[[^\]]*\]\((?:<)?([^)\s>]+)(?:>)?(?:\s+["'][^)]*["'])?\)/g)].map(match => match[1]),
    ...[...markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]),
  ];
  return [...new Set(paths.filter(path => !/^(?:https?:|data:|app:)/i.test(path)).map(path => path.split(/[?#]/, 1)[0]))];
}

export function extractFormulaEntries(markdown: string): FormulaEntry[] {
  const matches: Array<{ latex: string; offset: number }> = [];
  const patterns = [/\$\$([\s\S]*?)\$\$/g, /\\\[([\s\S]*?)\\\]/g, /\\begin\{(?:equation\*?|align\*?|gather\*?)\}([\s\S]*?)\\end\{(?:equation\*?|align\*?|gather\*?)\}/g];
  for (const pattern of patterns) {
    for (const match of markdown.matchAll(pattern)) {
      const latex = match[1]?.trim();
      if (latex && match.index !== undefined) matches.push({ latex, offset: match.index });
    }
  }
  matches.sort((a, b) => a.offset - b.offset);
  const seen = new Set<string>();
  return matches.filter(item => {
    const key = item.latex.replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((item, index) => {
    const before = markdown.slice(Math.max(0, item.offset - 500), item.offset);
    const after = markdown.slice(item.offset + item.latex.length, item.offset + item.latex.length + 500);
    const tag = item.latex.match(/\\tag\{([^}]+)\}/)?.[1]
      ?? before.match(/(?:Eq\.?|Equation|公式)\s*\(?([A-Za-z0-9.\-]+)\)?\s*[:：]?\s*$/i)?.[1];
    return { id: tag ? `Eq. ${tag}` : `公式 ${index + 1}`, latex: item.latex, context: `${before}\n\n${after}`.trim(), offset: item.offset };
  });
}

export function formulaIndexMarkdown(formulas: FormulaEntry[]): string {
  if (formulas.length === 0) return 'MinerU Markdown 中没有识别到独立公式块。';
  return formulas.map(formula => `### ${formula.id}\n\n$$\n${formula.latex}\n$$\n\n上下文：${formula.context.slice(0, 600)}`).join('\n\n');
}

function decodeSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function supplementaryIndex(file: TFile, prefix: string): number {
  return Number.parseInt(file.basename.slice(prefix.length), 10);
}
