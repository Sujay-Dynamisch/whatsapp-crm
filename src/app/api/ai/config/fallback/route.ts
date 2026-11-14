// ============================================================
// /api/ai/config/fallback — backup AI provider (migration 096). Admins.
//   GET     { enabled, provider, model, base_url, has_key }
//   POST    { enabled, provider, model, base_url?, api_key? }
//           (key tested before saving; blank key = keep the stored one
//            when provider / endpoint are unchanged)
//   DELETE  remove the backup
// Used only when the primary model fails, so a free primary key keeps
// costs low and the paid backup only answers when it has to.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { AiError } from '@/lib/ai/types'
import { AI_PROVIDER_INFO, isAiProvider } from '@/lib/ai/providers/registry'
import { normalizeOpenAiCompatibleBaseUrl } from '@/lib/ai/providers/openai-compatible'
import { canReuseStoredAiKey } from '@/lib/ai/stored-key'

const COLS = 'fallback_enabled, fallback_provider, fallback_model, fallback_base_url, fallback_api_key'

export async function GET() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data, error } = await supabase.from('ai_configs').select(COLS).eq('account_id', accountId).maybeSingle()
    if (error) {
      if (/fallback_/.test(error.message)) return NextResponse.json({ error: 'Run migration 096 to enable the backup model.' }, { status: 409 })
      throw error
    }
    return NextResponse.json({
      enabled: !!data?.fallback_enabled,
      provider: data?.fallback_provider ?? null,
      model: data?.fallback_model ?? null,
      base_url: data?.fallback_base_url ?? null,
      has_key: !!data?.fallback_api_key,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-fallback:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      enabled?: unknown
      provider?: unknown
      model?: unknown
      base_url?: unknown
      api_key?: unknown
    }
    const bad = (error: string) => NextResponse.json({ error }, { status: 400 })

    const { data: cfg } = await supabase
      .from('ai_configs')
      .select(`id, provider, model, ${COLS}`)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!cfg) return bad('Set up the main AI model first.')

    if (!isAiProvider(body.provider)) return bad('Choose a provider')
    const provider = body.provider
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 120) : AI_PROVIDER_INFO[provider].defaultModel
    let baseUrl: string | null = null
    if (provider === 'openai_compatible') {
      const raw = typeof body.base_url === 'string' ? body.base_url.trim() : ''
      if (!raw) return bad('Enter the endpoint URL')
      try {
        baseUrl = normalizeOpenAiCompatibleBaseUrl(raw)
      } catch (e) {
        return bad(e instanceof Error ? e.message : 'Invalid endpoint URL')
      }
    }
    if (provider === cfg.provider && model === cfg.model) return bad('The backup must be a different provider or model than the main one.')

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKey = rawKey
    const stored = cfg.fallback_provider && isAiProvider(cfg.fallback_provider)
      ? { provider: cfg.fallback_provider, base_url: cfg.fallback_base_url as string | null }
      : null
    if (!apiKey) {
      if (cfg.fallback_api_key && canReuseStoredAiKey(stored, provider, baseUrl)) {
        try {
          apiKey = decrypt(cfg.fallback_api_key as string)
        } catch {
          return bad('The saved backup key can no longer be read — enter it again.')
        }
      } else {
        return bad('Enter the API key for the backup model')
      }
    }

    const changed = !!rawKey || provider !== cfg.fallback_provider || model !== cfg.fallback_model || baseUrl !== (cfg.fallback_base_url ?? null)
    if (changed) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey,
          baseUrl,
          systemPrompt: null,
          isActive: true,
          autoReplyEnabled: false,
          autoReplyMaxPerConversation: 1,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (err) {
        if (err instanceof AiError) return NextResponse.json({ error: `Backup key check failed: ${err.message}`, code: err.code }, { status: 400 })
        throw err
      }
    }

    const { error } = await supabase
      .from('ai_configs')
      .update({
        fallback_enabled: body.enabled !== false,
        fallback_provider: provider,
        fallback_model: model,
        fallback_base_url: baseUrl,
        ...(rawKey ? { fallback_api_key: encrypt(rawKey) } : {}),
      })
      .eq('id', cfg.id)
    if (error) throw error
    return NextResponse.json({ ok: true, enabled: body.enabled !== false, provider, model, base_url: baseUrl, has_key: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .update({ fallback_enabled: false, fallback_provider: null, fallback_model: null, fallback_base_url: null, fallback_api_key: null })
      .eq('account_id', accountId)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (error) {
    return toErrorResponse(error)
  }
}
