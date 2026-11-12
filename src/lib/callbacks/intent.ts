// ============================================================
// AI callback-intent detection (caller management, migration 087).
//
// A typed inbound message asking to be called ("please call me, typing
// is difficult", "mujhe call karo", "मला फोन करा") becomes a priority
// callback — no button needed. Flow:
//
//   cheap keyword pre-check → account's AI model classifies (JSON) →
//   open_callback_from_intent() (idempotent by WhatsApp message id)
//
// Clear + confident → priority task (+ callback_requested tag so
// journeys react as they do to the button). Ambiguous → a normal
// "needs review" task. The classifier never replies, calls, or creates
// a registration / engagement. Only for 'caller_management' accounts.
// Never throws.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { accountHasFeature } from '@/lib/features-server';
import { loadAiConfig } from '@/lib/ai/config';
import { generateReply } from '@/lib/ai/generate';
import type { AiConfig } from '@/lib/ai/types';
import { CALLBACK_TAG } from '@/lib/callbacks/followups';

/** Words that make a callback request possible at all (English, Hindi, Marathi, Hinglish). */
const HINT_RE =
  /\b(call|calling|ring|phone|speak|talk|baat|bat\s*kar|contact\s+me|callback)\b|कॉल|काॅल|फोन|फ़ोन|बात|संपर्क|बोल/i;

export function mightRequestCallback(text: string): boolean {
  const t = text.trim();
  return t.length >= 3 && t.length <= 2000 && HINT_RE.test(t);
}

export interface CallbackIntent {
  intent: 'callback_request' | 'ambiguous' | 'none';
  confidence: number;
  language: string | null;
  requested_time: string | null;
  reason: string;
}

export const CLASSIFIER_PROMPT = `You classify ONE inbound WhatsApp message from a customer of an Indian business.
Decide whether the customer is asking the business to PHONE them (a callback), prefers speaking over typing, or names a time to be called.
Messages may be English, Hindi, Marathi, Hinglish or mixed.

Rules:
- "callback_request": they clearly want a phone call / to talk on the phone (e.g. "please call me", "typing is difficult, can you call", "mujhe call karo", "मला फोन करा", "call me at 6pm").
- "ambiguous": it might be a call request but it is unclear.
- "none": ordinary mentions that are not a request to be called (e.g. "I was on a call", "the call yesterday was great", "what time is the webinar call?").
- requested_time: the time/day they named, copied as written (e.g. "after 6 pm", "tomorrow morning"); null when none. Never invent a time.
- language: ISO-like code: en, hi, mr, or mixed.

Reply with ONLY this JSON, no prose:
{"intent":"callback_request|ambiguous|none","confidence":0.0-1.0,"language":"en","requested_time":null,"reason":"short evidence"}`;

/** Parse the model's JSON (tolerates code fences / surrounding text). */
export function parseIntent(raw: string): CallbackIntent | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as Record<string, unknown>;
    const intent = o.intent === 'callback_request' || o.intent === 'ambiguous' || o.intent === 'none' ? o.intent : null;
    if (!intent) return null;
    const c = Number(o.confidence);
    return {
      intent,
      confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0,
      language: typeof o.language === 'string' ? o.language.slice(0, 10) : null,
      requested_time: typeof o.requested_time === 'string' && o.requested_time.trim() ? o.requested_time.trim().slice(0, 100) : null,
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 300) : '',
    };
  } catch {
    return null;
  }
}

/** Definite (auto-priority), review, or ignore — by intent and the account's threshold. */
export function decide(r: CallbackIntent, threshold: number): 'definite' | 'review' | 'ignore' {
  if (r.intent === 'callback_request' && r.confidence >= threshold) return 'definite';
  if (r.intent === 'none') return 'ignore';
  // Low-confidence request, or ambiguous with some signal → a human looks.
  return r.confidence >= 0.4 ? 'review' : 'ignore';
}

export async function classifyCallbackIntent(config: AiConfig, text: string): Promise<CallbackIntent | null> {
  const res = await generateReply({
    config,
    systemPrompt: CLASSIFIER_PROMPT,
    messages: [{ role: 'user', content: text.slice(0, 2000) }],
  });
  return parseIntent(res.text);
}

export interface DetectInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** WhatsApp message id — the idempotency key. */
  waMessageId: string;
  text: string;
}

export async function detectCallbackIntent(
  db: SupabaseClient,
  input: DetectInput,
  classify: (config: AiConfig, text: string) => Promise<CallbackIntent | null> = classifyCallbackIntent
): Promise<string> {
  try {
    if (!mightRequestCallback(input.text)) return 'no_hint';
    if (!(await accountHasFeature(db, input.accountId, 'caller_management'))) return 'off';
    if (!(await accountHasFeature(db, input.accountId, 'callbacks'))) return 'off';

    const { data: settings } = await db
      .from('callback_settings')
      .select('ai_detection_enabled, ai_confidence_threshold')
      .eq('account_id', input.accountId)
      .maybeSingle();
    if (settings && settings.ai_detection_enabled === false) return 'disabled';
    const threshold = Number(settings?.ai_confidence_threshold ?? 0.75);

    const config = await loadAiConfig(db, input.accountId, { requireActive: false });
    if (!config?.apiKey) return 'no_ai';

    const result = await classify(config, input.text);
    if (!result) return 'unparsed';
    const verdict = decide(result, threshold);
    if (verdict === 'ignore') return 'ignored';

    const { data: outcome, error } = await db.rpc('open_callback_from_intent', {
      p_account_id: input.accountId,
      p_contact_id: input.contactId,
      p_conversation_id: input.conversationId,
      p_message_id: input.waMessageId,
      p_text: input.text,
      p_definite: verdict === 'definite',
      p_meta: {
        confidence: result.confidence,
        language: result.language,
        requested_time: result.requested_time ?? 'ASAP / time not specified',
        reason: result.reason,
        model: `${config.provider}:${config.model}`,
        intent_type: 'CALLBACK_REQUEST',
      },
    });
    if (error) throw new Error(error.message);

    // Same tag the button sets, so journeys treat both alike (the trigger
    // sees the open priority task and doesn't duplicate it).
    if (outcome === 'created' || outcome === 'upgraded') {
      const { data: tag } = await db
        .from('tags')
        .select('id')
        .eq('account_id', input.accountId)
        .ilike('name', CALLBACK_TAG)
        .limit(1)
        .maybeSingle();
      if (tag) {
        const { addContactTagIfAbsent } = await import('@/lib/contacts/tag-write');
        await addContactTagIfAbsent(db, { accountId: input.accountId, contactId: input.contactId, tagId: tag.id as string });
      }
    }
    return String(outcome);
  } catch (err) {
    console.error('[callbacks] intent detection failed:', err instanceof Error ? err.message : err);
    return 'error';
  }
}
