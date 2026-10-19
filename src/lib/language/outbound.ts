// ============================================================
// Outbound translation (migration 049): the agent types in their own
// language, the customer receives theirs.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from '@/lib/ai/config';
import { accountHasFeature } from '@/lib/features-server';

import { loadLanguageSettings } from './inbound';
import { translateText } from './translate';

export class TranslationUnavailableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = 'TranslationUnavailableError';
  }
}

export interface OutgoingText {
  /** What to send. */
  text: string;
  /** What the agent typed, when `text` is a translation of it. */
  original: string | null;
  language: string | null;
}

/**
 * Translate an agent's message into the conversation's customer
 * language. Returns the text unchanged when no translation is needed
 * (unknown customer language, or it already matches the agents').
 * Throws when translation was asked for but can't be done, so the
 * agent never sends untranslated text by surprise.
 */
export async function translateOutgoing(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; text: string }
): Promise<OutgoingText> {
  const unchanged: OutgoingText = { text: args.text, original: null, language: null };
  if (!args.text.trim()) return unchanged;

  if (!(await accountHasFeature(db, args.accountId, 'translation'))) {
    throw new TranslationUnavailableError('Translation is not enabled for your account.');
  }

  const { data: conv } = await db
    .from('conversations')
    .select('customer_language')
    .eq('id', args.conversationId)
    .eq('account_id', args.accountId)
    .maybeSingle();
  const target = (conv?.customer_language as string | null) ?? null;
  const settings = await loadLanguageSettings(db, args.accountId);
  if (!target || target === settings.agent_language) return unchanged;

  const ai = await loadAiConfig(db, args.accountId, { requireActive: false });
  if (!ai) {
    throw new TranslationUnavailableError(
      'Translation needs an AI provider key — add one under AI Agents → Setup.'
    );
  }

  const t = await translateText({ config: ai, text: args.text, target });
  return t.translation
    ? { text: t.translation, original: args.text, language: target }
    : unchanged;
}
