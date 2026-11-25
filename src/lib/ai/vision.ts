import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'

/**
 * Customer images for the AI. The chat model may be text-only (e.g. Groq),
 * so an image is described once by the account's OpenAI model (primary or
 * backup) and the description is stored in `messages.transcript` — the
 * same field voice notes use — so `buildConversationContext` reads it as
 * text. No OpenAI key → the image stays "[image]" and the prompt tells the
 * AI to thank them and say the team will check it.
 */
const PROMPT =
  'You describe an image a customer sent on WhatsApp to a business, for a support agent who cannot see it. ' +
  'Answer in at most 2 short sentences. If it is a payment receipt / UPI / bank transfer screenshot, start with ' +
  '"PAYMENT RECEIPT:" and give the amount, who it was paid to, the date and whether it says successful. ' +
  'Otherwise just say what it shows. Never invent details you cannot read.'

function openAiKey(config: AiConfig): { apiKey: string; model: string } | null {
  if (config.provider === 'openai' && config.apiKey) return { apiKey: config.apiKey, model: config.model }
  const fb = config.fallback
  if (fb?.provider === 'openai' && fb.apiKey) return { apiKey: fb.apiKey, model: fb.model }
  return null
}

async function describe(key: { apiKey: string; model: string }, url: string): Promise<string | null> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: key.model,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: [{ type: 'image_url', image_url: { url } }] },
      ],
      max_completion_tokens: 300,
    }),
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) return null
  const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[] } | null
  const text = data?.choices?.[0]?.message?.content?.trim()
  return text ? text.slice(0, 500) : null
}

/** Describe this conversation's recent, not-yet-described customer images. Never throws. */
export async function describeRecentImages(db: SupabaseClient, config: AiConfig, conversationId: string): Promise<void> {
  try {
    const key = openAiKey(config)
    if (!key) return
    const { data } = await db
      .from('messages')
      .select('id, media_url')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .eq('content_type', 'image')
      .is('transcript', null)
      .not('media_url', 'is', null)
      .gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString())
      .order('created_at', { ascending: false })
      .limit(2)
    // In parallel: the webhook has a 60 s budget for the whole AI reply.
    await Promise.all(
      ((data ?? []) as { id: string; media_url: string }[]).map(async (m) => {
        const text = await describe(key, m.media_url).catch(() => null)
        if (text) await db.from('messages').update({ transcript: text }).eq('id', m.id)
      }),
    )
  } catch (err) {
    console.warn('[ai vision] describe failed:', err instanceof Error ? err.message : err)
  }
}
