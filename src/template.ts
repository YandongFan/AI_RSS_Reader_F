import type { NotePropertyTemplate } from './types';

export type TemplateValue = string | string[];
export type TemplateContext = Record<string, TemplateValue>;

export function renderNoteTemplate(template: string, context: TemplateContext): string {
  return template.replace(/{{\s*([^}]+?)\s*}}/g, (_match, expression: string) => stringify(evaluateExpression(expression, context)));
}

export function buildYamlProperties(properties: NotePropertyTemplate[], context: TemplateContext): string {
  return properties
    .filter((property) => property.name.trim())
    .map((property) => `${yamlKey(property.name.trim())}: ${yamlValue(evaluateTemplateValue(property.value, context), property.type)}`)
    .join('\n');
}

function evaluateTemplateValue(template: string, context: TemplateContext): TemplateValue {
  const exact = template.match(/^{{\s*([^}]+?)\s*}}$/);
  return exact ? evaluateExpression(exact[1], context) : renderNoteTemplate(template, context);
}

function evaluateExpression(expression: string, context: TemplateContext): TemplateValue {
  const [variable, ...filters] = expression.split('|').map((part) => part.trim());
  let value: TemplateValue = context[variable] ?? '';
  for (const filterExpression of filters) {
    const separator = filterExpression.indexOf(':');
    const name = (separator >= 0 ? filterExpression.slice(0, separator) : filterExpression).trim().toLowerCase();
    const argument = separator >= 0 ? parseArgument(filterExpression.slice(separator + 1).trim()) : '';
    if (name === 'split') value = Array.isArray(value) ? value : value.split(argument || ',').map((item) => item.trim()).filter(Boolean);
    else if (name === 'wikilink') value = asArray(value).map((item) => `[[${item}]]`);
    else if (name === 'join') value = Array.isArray(value) ? value.join(argument || ', ') : value;
    else if (name === 'trim') value = Array.isArray(value) ? value.map((item) => item.trim()) : value.trim();
    else if (name === 'lower') value = Array.isArray(value) ? value.map((item) => item.toLowerCase()) : value.toLowerCase();
    else if (name === 'upper') value = Array.isArray(value) ? value.map((item) => item.toUpperCase()) : value.toUpperCase();
  }
  return value;
}

function parseArgument(value: string): string {
  try { return JSON.parse(value) as string; } catch { return value.replace(/^['"]|['"]$/g, ''); }
}

function yamlValue(value: TemplateValue, type: NotePropertyTemplate['type']): string {
  if (type === 'multitext') return `[${toList(value).map((item) => JSON.stringify(item)).join(', ')}]`;
  const scalar = stringify(value).replace(/\r?\n/g, ' ').trim();
  if (type === 'date' && /^\d{4}-\d{2}-\d{2}/.test(scalar)) return scalar.slice(0, 10);
  if (type === 'number' && scalar !== '' && Number.isFinite(Number(scalar))) return scalar;
  if (type === 'checkbox') return /^(true|yes|1)$/i.test(scalar) ? 'true' : 'false';
  return JSON.stringify(scalar);
}

function toList(value: TemplateValue): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  const wikilinks = [...value.matchAll(/\[\[([^\]]+)]]/g)].map((match) => `[[${match[1]}]]`);
  if (wikilinks.length > 0) return wikilinks;
  return value.split(/\s*[,;，；]\s*/).map((item) => item.trim()).filter(Boolean);
}

function asArray(value: TemplateValue): string[] { return Array.isArray(value) ? value : [value].filter(Boolean); }
function stringify(value: TemplateValue): string { return Array.isArray(value) ? value.join(', ') : value; }
function yamlKey(value: string): string { return /^[A-Za-z_][\w-]*$/.test(value) ? value : JSON.stringify(value); }
