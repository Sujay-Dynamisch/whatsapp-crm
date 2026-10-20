import { Fragment, type ReactNode } from 'react'

/**
 * Render WhatsApp's inline formatting the way the app does:
 *
 *   *bold*   _italic_   ~strikethrough~   ```monospace```   `inline code`
 *
 * Same rules as WhatsApp: a marker only opens/closes when it hugs
 * non-space text (`* not bold *` stays literal), styles don't cross a
 * line break (except ``` blocks), and a marker glued to a letter or
 * digit is literal — so `snake_case_name` and `2*3*4` are left alone.
 * Bold / italic / strike nest (`*_both_*`); code is never re-parsed.
 */
const PATTERN = new RegExp(
  [
    '```([\\s\\S]+?)```',
    '`([^`\\n]+)`',
    '(?<![\\p{L}\\p{N}*])\\*(?=\\S)([^*\\n]*?\\S)\\*(?![\\p{L}\\p{N}*])',
    '(?<![\\p{L}\\p{N}_])_(?=\\S)([^_\\n]*?\\S)_(?![\\p{L}\\p{N}_])',
    '(?<![\\p{L}\\p{N}~])~(?=\\S)([^~\\n]*?\\S)~(?![\\p{L}\\p{N}~])',
  ].join('|'),
  'gu',
)

export function renderWhatsAppText(text: string, keyPrefix = 'wa'): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(PATTERN)) {
    const start = m.index ?? 0
    if (start > last) out.push(text.slice(last, start))
    const key = `${keyPrefix}-${i++}`
    const [, block, code, bold, italic, strike] = m
    if (block !== undefined) {
      out.push(
        <code key={key} className="font-mono whitespace-pre-wrap">
          {block}
        </code>,
      )
    } else if (code !== undefined) {
      out.push(
        <code key={key} className="rounded bg-black/10 px-1 font-mono dark:bg-white/10">
          {code}
        </code>,
      )
    } else if (bold !== undefined) {
      out.push(<strong key={key} className="font-bold">{renderWhatsAppText(bold, key)}</strong>)
    } else if (italic !== undefined) {
      out.push(<em key={key}>{renderWhatsAppText(italic, key)}</em>)
    } else if (strike !== undefined) {
      out.push(<s key={key}>{renderWhatsAppText(strike, key)}</s>)
    }
    last = start + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out.map((node, idx) =>
    typeof node === 'string' ? <Fragment key={`${keyPrefix}-t${idx}`}>{node}</Fragment> : node,
  )
}
