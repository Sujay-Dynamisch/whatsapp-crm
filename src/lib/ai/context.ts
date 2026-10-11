import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  transcript?: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  // Voice notes count as text once transcribed (migration 049). If that
  // migration hasn't run, fall back to the text-only query.
  const query = (withTranscripts: boolean) =>
    db
      .from('messages')
      .select(withTranscripts ? 'sender_type, content_text, transcript' : 'sender_type, content_text')
      .eq('conversation_id', conversationId)
      .in('content_type', withTranscripts ? ['text', 'interactive', 'audio'] : ['text', 'interactive'])
      .order('created_at', { ascending: false })
      .limit(limit)

  let { data, error } = await query(true)
  if (error && /transcript/.test(error.message)) ({ data, error } = await query(false))
  if (error) throw error

  const rows = ((data ?? []) as unknown as DbMessage[]).reverse()
  return rows
    .map((m) => ({ m, text: (m.content_text || m.transcript || '').trim() }))
    .filter(({ text }) => text)
    .map(({ m, text }) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: text,
    }))
}
