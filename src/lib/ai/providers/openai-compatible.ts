import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

// ============================================================
// Adapter for providers exposing the OpenAI Chat Completions API at
// their own base URL. Two kinds of caller:
//   - catalogue providers (Gemini, Groq, OpenRouter, xAI, Mistral,
//     DeepSeek, Cerebras) — a fixed, trusted base URL from the registry;
//   - the "OpenAI-compatible" provider — a base URL the account typed,
//     so it is normalised and SSRF-checked (https only, no private
//     targets unless AI_PROVIDER_ALLOWED_PRIVATE_HOSTS lists them).
// Same request/response shape as the native OpenAI adapter, but
// `max_tokens` (the widely supported field) rather than OpenAI's newer
// `max_completion_tokens`.
// ============================================================

const t = getT('LibErrors')

const PRIVATE_HOST_ALLOWLIST_ENV = 'AI_PROVIDER_ALLOWED_PRIVATE_HOSTS'

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env[PRIVATE_HOST_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map(normalizeHost)
      .filter(Boolean),
  )
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '')
  if (!value) {
    throw new AiError(t('ai.compatBaseUrlRequired'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AiError(t('ai.compatBaseUrlInvalid'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiError(t('ai.compatBaseUrlProtocol'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol === 'http:' && !allowedPrivateHosts().has(normalizeHost(parsed.hostname))) {
    throw new AiError(t('ai.compatBaseUrlHttpsRequired', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.username || parsed.password) {
    throw new AiError(t('ai.compatBaseUrlCredentials'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.search || parsed.hash) {
    throw new AiError(t('ai.compatBaseUrlQuery'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  const normalized = parsed.toString().replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

interface CompatResponse {
  choices?: { message?: { content?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export async function generateOpenAiCompatible(
  args: ProviderArgs & {
    /** Shown in errors ("Groq returned…"). */
    providerLabel?: string
    /** A fixed catalogue URL — skip the user-URL normalisation and SSRF check. */
    trusted?: boolean
  },
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args
  const providerLabel = args.providerLabel ?? 'OpenAI-compatible provider'

  let endpoint: string
  if (args.trusted) {
    endpoint = `${(baseUrl ?? '').replace(/\/+$/, '')}/chat/completions`
  } else {
    endpoint = normalizeOpenAiCompatibleBaseUrl(baseUrl ?? '')
    let deliverable = false
    try {
      deliverable = await isDeliverableUrl(endpoint, {
        allowPrivateHosts: allowedPrivateHosts(),
      })
    } catch {
      deliverable = false
    }
    if (!deliverable) {
      throw new AiError(t('ai.compatBlockedUrl', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
        code: 'blocked_url',
        status: 400,
      })
    }
  }

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        // Optional attribution OpenRouter shows on its dashboard;
        // ignored by every other provider.
        'X-Title': 'WACRM',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...mergeConsecutive(messages)],
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) throw await providerHttpError(providerLabel, res)

  const data = (await res.json().catch(() => null)) as CompatResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new AiError(t('ai.emptyResponse', { provider: providerLabel }), {
      code: 'empty_response',
    })
  }

  return {
    text,
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
