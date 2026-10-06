// ============================================================
// AI provider catalogue (bring-your-own-key).
//
// Pure data — safe to import from client components (the settings
// picker) and the server (generate.ts, route validation).
//
// Two native adapters (OpenAI, Anthropic) plus a family of
// OpenAI-compatible APIs that share one adapter and differ only by
// base URL. Default models are a starting point the user can edit:
// providers rename and retire models often, and "Test key" checks the
// exact provider + model + key before anything is saved.
//
// Keys are persisted in ai_configs.provider / ai_usage_log.provider —
// never rename one, only add (and widen the DB CHECK, see migration 047).
// ============================================================

export const AI_PROVIDERS = [
  'openai',
  'anthropic',
  'gemini',
  'groq',
  'openrouter',
  'xai',
  'mistral',
  'deepseek',
  'cerebras',
] as const;

export type AiProviderId = (typeof AI_PROVIDERS)[number];

export interface AiProviderInfo {
  label: string;
  /** Which adapter talks to it. */
  adapter: 'openai' | 'anthropic' | 'openai_compatible';
  /** Chat-completions base URL for OpenAI-compatible providers. */
  baseUrl?: string;
  defaultModel: string;
  /** A few model ids to try — shown as hints, never an allow-list. */
  modelHints: string[];
  keyPlaceholder: string;
  /** Where the user creates a key. */
  keyUrl: string;
  /** Has a no-cost tier (rate-limited). */
  freeTier: boolean;
  /** One-line note shown under the picker. */
  note: string;
}

export const AI_PROVIDER_INFO: Record<AiProviderId, AiProviderInfo> = {
  openai: {
    label: 'OpenAI',
    adapter: 'openai',
    defaultModel: 'gpt-5.4-mini',
    modelHints: ['gpt-5.4-mini', 'gpt-4o-mini'],
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    freeTier: false,
    note: 'Paid, pay-as-you-go. Needs billing or credits on the OpenAI project.',
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    adapter: 'anthropic',
    defaultModel: 'claude-haiku-4-5-20251001',
    modelHints: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5'],
    keyPlaceholder: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    freeTier: false,
    note: 'Paid, pay-as-you-go.',
  },
  gemini: {
    label: 'Google Gemini',
    adapter: 'openai_compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    modelHints: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
    keyPlaceholder: 'AIza...',
    keyUrl: 'https://aistudio.google.com/apikey',
    freeTier: true,
    note: 'Free tier via Google AI Studio (rate-limited). On the free tier Google may use prompts to improve its products.',
  },
  groq: {
    label: 'Groq',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    modelHints: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    keyPlaceholder: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
    freeTier: true,
    note: 'Free tier with per-minute and per-day limits. Very fast open models.',
  },
  openrouter: {
    label: 'OpenRouter',
    adapter: 'openai_compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    modelHints: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.5-flash'],
    keyPlaceholder: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
    freeTier: true,
    note: 'One key for hundreds of models. Model ids ending in ":free" cost nothing (rate-limited).',
  },
  xai: {
    label: 'xAI (Grok)',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-3-mini',
    modelHints: ['grok-3-mini', 'grok-4'],
    keyPlaceholder: 'xai-...',
    keyUrl: 'https://console.x.ai',
    freeTier: false,
    note: 'Paid; new accounts sometimes get promotional credits.',
  },
  mistral: {
    label: 'Mistral',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    modelHints: ['mistral-small-latest', 'mistral-large-latest'],
    keyPlaceholder: 'Mistral API key',
    keyUrl: 'https://console.mistral.ai/api-keys',
    freeTier: true,
    note: 'Free "Experiment" plan (rate-limited; requires phone verification).',
  },
  deepseek: {
    label: 'DeepSeek',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    modelHints: ['deepseek-chat'],
    keyPlaceholder: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    freeTier: false,
    note: 'Paid but very low cost.',
  },
  cerebras: {
    label: 'Cerebras',
    adapter: 'openai_compatible',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama-3.3-70b',
    modelHints: ['llama-3.3-70b', 'llama3.1-8b'],
    keyPlaceholder: 'csk-...',
    keyUrl: 'https://cloud.cerebras.ai',
    freeTier: true,
    note: 'Free tier with daily token limits. Very fast open models.',
  },
};

export function isAiProvider(value: unknown): value is AiProviderId {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}
