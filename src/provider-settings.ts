import type { AiRssSettings, ProviderKind, ProviderSettings } from './types';

export const PROVIDER_KINDS: ProviderKind[] = ['openai', 'codex', 'deepseek', 'gemini', 'ollama', 'custom'];

export const DEFAULT_PROVIDER_CONFIGS: Record<ProviderKind, ProviderSettings> = {
  openai: { kind: 'openai', apiKey: '', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', codexExecutable: 'codex' },
  codex: { kind: 'codex', apiKey: '', model: '', baseUrl: '', codexExecutable: 'codex' },
  deepseek: { kind: 'deepseek', apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', codexExecutable: 'codex' },
  gemini: { kind: 'gemini', apiKey: '', model: 'gemini-2.0-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', codexExecutable: 'codex' },
  ollama: { kind: 'ollama', apiKey: '', model: 'llama3', baseUrl: 'http://localhost:11434', codexExecutable: 'codex' },
  custom: { kind: 'custom', apiKey: '', model: '', baseUrl: '', codexExecutable: 'codex' },
};

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && PROVIDER_KINDS.includes(value as ProviderKind);
}

function normalizedProvider(kind: ProviderKind, value?: Partial<ProviderSettings>): ProviderSettings {
  return { ...DEFAULT_PROVIDER_CONFIGS[kind], ...value, kind };
}

export function normalizeProviderConfigs(
  active?: Partial<ProviderSettings>,
  saved?: Partial<Record<ProviderKind, Partial<ProviderSettings>>>,
): Record<ProviderKind, ProviderSettings> {
  const configs = Object.fromEntries(PROVIDER_KINDS.map((kind) => [kind, normalizedProvider(kind, saved?.[kind])])) as Record<ProviderKind, ProviderSettings>;
  if (isProviderKind(active?.kind)) configs[active.kind] = normalizedProvider(active.kind, { ...configs[active.kind], ...active });
  return configs;
}

export function syncActiveProvider(settings: Pick<AiRssSettings, 'provider' | 'providerConfigs'>): void {
  const kind = settings.provider.kind;
  settings.providerConfigs[kind] = normalizedProvider(kind, settings.provider);
}

export function switchProvider(settings: Pick<AiRssSettings, 'provider' | 'providerConfigs'>, kind: ProviderKind): void {
  syncActiveProvider(settings);
  settings.provider = normalizedProvider(kind, settings.providerConfigs[kind]);
}
