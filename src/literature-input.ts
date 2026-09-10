/** Normalize a user-supplied paper URL or DOI without fetching the page. */
export function normalizeLiteratureInput(input: string): string {
  const value = input.trim().replace(/^doi:\s*/i, '');
  if (/^10\.\d{4,9}\/\S+$/i.test(value)) {
    return `https://doi.org/${value.split('/').map(encodeURIComponent).join('/')}`;
  }
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || /\s/.test(value)) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error('请输入完整的 http(s) 文献链接或有效 DOI（例如 10.1038/nature12373）');
  }
}

/** Normalize distinct non-empty lines supplied to the manual literature importer. */
export function normalizeLiteratureInputs(input: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      const link = normalizeLiteratureInput(line);
      if (!seen.has(link)) {
        seen.add(link);
        links.push(link);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`第 ${index + 1} 行：${message}`);
    }
  }
  if (links.length === 0) throw new Error('请输入至少一个完整的 http(s) 文献链接或有效 DOI');
  return links;
}

/** Normalize a vault-relative root folder selected for an interactive save. */
export function normalizeLiteratureSaveFolder(value: string): string {
  const raw = value.trim();
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/g, '').replace(/\/{2,}/g, '/');
  if (!normalized) throw new Error('请输入保存文件夹');
  const invalidPart = (part: string): boolean => !part || part === '.' || part === '..'
    || /[<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part);
  if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(normalized) || normalized.split('/').some(invalidPart)) {
    throw new Error('保存位置必须是 Obsidian 库内的相对文件夹，例如 Papers/Literature');
  }
  return normalized;
}
