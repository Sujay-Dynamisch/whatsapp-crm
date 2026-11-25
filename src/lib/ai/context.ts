import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  transcript?: string | null
}

/**
 * The text the model sees for one message. Images carry their caption and
 * the vision description (vision.ts, stored in `transcript`); videos can't
 * be watched, so the model is told so.
 */
function messageText(m: DbMessage): string {
  const caption = (m.content_text || '').trim()
  if (m.content_type === 'image') {
    const seen = (m.transcript || '').trim()
    return `[The customer sent an image${seen ? `: ${seen}` : ' (you cannot see it)'}]${caption ? `\n${caption}` : ''}`
  }
  if (m.content_type === 'video') {
    return `[The customer sent a video — you cannot watch videos]${caption ? `\n${caption}` : ''}`
  }
  return (m.content_text || m.transcript || '').trim()
}

/**
 * Fetch the last N messages of a conversation that carry something to
 * model and map them to the provider-neutral chat shape. Customer messages
 * become `user`; agent and bot messages become `assistant`. Text,
 * interactive replies, transcribed voice notes, and customer images /
 * videos (as a short description) are included; templates and other
 * media are not.
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
      .select(withTranscripts ? 'sender_type, content_type, content_text, transcript' : 'sender_type, content_type, content_text')
      .eq('conversation_id', conversationId)
      .in('content_type', withTranscripts ? ['text', 'interactive', 'audio', 'image', 'video'] : ['text', 'interactive', 'image', 'video'])
      .order('created_at', { ascending: false })
      .limit(limit)

  let { data, error } = await query(true)
  if (error && /transcript/.test(error.message)) ({ data, error } = await query(false))
  if (error) throw error

  const rows = ((data ?? []) as unknown as DbMessage[]).reverse()
  return rows
    // Only the customer's media: an agent's image has no text for the model.
    .filter((m) => m.sender_type === 'customer' || (m.content_type !== 'image' && m.content_type !== 'video'))
    .map((m) => ({ m, text: messageText(m) }))
    .filter(({ text }) => text)
    .map(({ m, text }) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: text,
    }))
}
