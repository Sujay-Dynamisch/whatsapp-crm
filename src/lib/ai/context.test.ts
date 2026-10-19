import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})

describe('buildConversationContext — voice notes (migration 049)', () => {
  it('includes transcribed voice notes as customer text', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: null, transcript: 'kal delivery chahiye' },
        { sender_type: 'agent', content_text: 'Hi! How can I help?' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([
      { role: 'assistant', content: 'Hi! How can I help?' },
      { role: 'user', content: 'kal delivery chahiye' },
    ])
  })

  it('falls back to text-only when the transcript column does not exist yet', async () => {
    const calls: string[] = []
    let attempt = 0
    const chain = {
      from: () => chain,
      select: (cols: string) => (calls.push(cols), chain),
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () =>
        Promise.resolve(
          attempt++ === 0
            ? { data: null, error: { message: 'column messages.transcript does not exist' } }
            : { data: [{ sender_type: 'customer', content_text: 'hello' }], error: null },
        ),
    }
    const out = await buildConversationContext(chain as unknown as SupabaseClient, 'conv-1')
    expect(out).toEqual([{ role: 'user', content: 'hello' }])
    expect(calls).toEqual(['sender_type, content_text, transcript', 'sender_type, content_text'])
  })
})
