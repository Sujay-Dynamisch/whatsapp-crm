import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderWhatsAppText } from './format-text'

const html = (text: string) => renderToStaticMarkup(<>{renderWhatsAppText(text)}</>)

describe('renderWhatsAppText', () => {
  it('bolds *text*, including around variables', () => {
    expect(html('Hi *{{1}}*, get *20% off*!')).toBe(
      'Hi <strong class="font-bold">{{1}}</strong>, get <strong class="font-bold">20% off</strong>!',
    )
  })

  it('renders italic, strikethrough and monospace', () => {
    expect(html('_a_ ~b~ ```c *d*```')).toBe(
      '<em>a</em> <s>b</s> <code class="font-mono whitespace-pre-wrap">c *d*</code>',
    )
  })

  it('nests bold and italic', () => {
    expect(html('*_both_*')).toBe('<strong class="font-bold"><em>both</em></strong>')
  })

  it('leaves markers literal where WhatsApp does', () => {
    expect(html('* not bold *')).toBe('* not bold *')
    expect(html('snake_case_name')).toBe('snake_case_name')
    expect(html('2*3*4')).toBe('2*3*4')
    expect(html('*a\nb*')).toBe('*a\nb*')
  })

  it('allows punctuation around markers', () => {
    expect(html('(*ok*).')).toBe('(<strong class="font-bold">ok</strong>).')
  })
})
