import { describe, expect, it } from 'vitest'
import { normalizeMetaTemplate } from './template-normalize'

describe('normalizeMetaTemplate', () => {
  it('1. normalizes a BODY-only template (not identified as carousel)', () => {
    const raw = {
      id: '12345678',
      name: 'navaratri_special_carousel',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: 'Hello {{1}}, festive greetings!',
          example: { body_text: [['Amit']] },
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('standard')
    expect(res.carousel).toBeNull()
    expect(res.body_text).toBe('Hello {{1}}, festive greetings!')
    expect(res.sample_values).toEqual({ body: ['Amit'] })
    expect(res.meta_template_id).toBe('12345678')
  })

  it('2. normalizes a BODY + HEADER template', () => {
    const raw = {
      id: '23456789',
      name: 'header_template',
      language: 'en_US',
      status: 'APPROVED',
      category: 'UTILITY',
      components: [
        {
          type: 'HEADER',
          format: 'IMAGE',
          example: { header_url: ['https://example.com/banner.jpg'] },
        },
        {
          type: 'BODY',
          text: 'Order updates inside',
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('standard')
    expect(res.header_type).toBe('image')
    expect(res.header_media_url).toBe('https://example.com/banner.jpg')
    expect(res.category).toBe('Utility')
  })

  it('3. normalizes a BODY + BUTTONS template', () => {
    const raw = {
      id: '34567890',
      name: 'buttons_template',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: 'Click below to stop',
        },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'QUICK_REPLY', text: 'Opt Out' },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('standard')
    expect(res.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Opt Out' }])
  })

  it('4. normalizes a BODY + CAROUSEL template correctly', () => {
    const raw = {
      id: '45678901',
      name: 'real_carousel_template',
      language: 'en_US',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: 'Check out our product catalog',
        },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                { type: 'BODY', text: 'Item 1 {{1}}', example: { body_text: [['$10']] } },
                { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'View Item' }] },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                { type: 'BODY', text: 'Item 2 {{1}}', example: { body_text: [['$20']] } },
                { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Buy Now' }] },
              ],
            },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('carousel')
    expect(res.carousel).toHaveLength(2)
    expect(res.carousel?.[0].card_index).toBe(0)
    expect(res.carousel?.[0].body_text).toBe('Item 1 {{1}}')
    expect(res.carousel?.[0].buttons).toEqual([{ type: 'QUICK_REPLY', text: 'View Item' }])
  })

  it('5. normalizes CAROUSEL with IMAGE header', () => {
    const raw = {
      id: '56789012',
      name: 'image_carousel',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: 'Featured Items',
        },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://example.com/card1.jpg'] } },
                { type: 'BODY', text: 'Card 1 text' },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'IMAGE', example: { header_url: ['https://example.com/card2.jpg'] } },
                { type: 'BODY', text: 'Card 2 text' },
              ],
            },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('carousel')
    expect(res.carousel?.[0].header_format).toBe('IMAGE')
    expect(res.carousel?.[0].header_media_url).toBe('https://example.com/card1.jpg')
  })

  it('6. normalizes CAROUSEL with VIDEO header format', () => {
    const raw = {
      id: '67890123',
      name: 'video_carousel',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        {
          type: 'BODY',
          text: 'Video Demos',
        },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'VIDEO', example: { header_url: ['https://example.com/demo1.mp4'] } },
                { type: 'BODY', text: 'Video 1' },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'VIDEO', example: { header_url: ['https://example.com/demo2.mp4'] } },
                { type: 'BODY', text: 'Video 2' },
              ],
            },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('carousel')
    expect(res.carousel?.[0].header_format).toBe('VIDEO')
  })

  it('7. preserves Multiple cards order and card_index', () => {
    const raw = {
      id: '78901234',
      name: 'multi_card_carousel',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Catalog' },
        {
          type: 'CAROUSEL',
          cards: [
            { components: [{ type: 'HEADER', format: 'PRODUCT_CORNER' }, { type: 'BODY', text: 'Card A' }] },
            { components: [{ type: 'HEADER', format: 'PRODUCT_CORNER' }, { type: 'BODY', text: 'Card B' }] },
            { components: [{ type: 'HEADER', format: 'PRODUCT_CORNER' }, { type: 'BODY', text: 'Card C' }] },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.carousel).toHaveLength(3)
    expect(res.carousel?.map((c) => c.card_index)).toEqual([0, 1, 2])
    expect(res.carousel?.map((c) => c.body_text)).toEqual(['Card A', 'Card B', 'Card C'])
  })

  it('8. normalizes Dynamic URL button on card', () => {
    const raw = {
      id: '89012345',
      name: 'dynamic_url_card',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Special Offers' },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                {
                  type: 'BUTTONS',
                  buttons: [
                    { type: 'URL', text: 'Track Order', url: 'https://example.com/orders/{{1}}', example: ['12345'] },
                  ],
                },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                {
                  type: 'BUTTONS',
                  buttons: [
                    { type: 'URL', text: 'Track Order', url: 'https://example.com/orders/{{1}}', example: ['67890'] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.carousel?.[0].buttons).toEqual([
      { type: 'URL', text: 'Track Order', url: 'https://example.com/orders/{{1}}', example: '12345' },
    ])
  })

  it('9. normalizes Quick Reply button on card', () => {
    const raw = {
      id: '90123456',
      name: 'quick_reply_card',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Choose Option' },
        {
          type: 'CAROUSEL',
          cards: [
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Select Red' }] },
              ],
            },
            {
              components: [
                { type: 'HEADER', format: 'PRODUCT_CORNER' },
                { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Select Blue' }] },
              ],
            },
          ],
        },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.carousel?.[0].buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Select Red' }])
  })

  it('10. preserves Unknown component in rawMetaData and logs warning', () => {
    const raw = {
      id: '01234567',
      name: 'future_component_template',
      language: 'en',
      status: 'APPROVED',
      category: 'MARKETING',
      components: [
        { type: 'BODY', text: 'Standard Body' },
        { type: 'UNKNOWN_FUTURE_TYPE', data: 'experimental' },
      ],
    }

    const res = normalizeMetaTemplate(raw)
    expect(res.template_type).toBe('standard')
    expect(res.raw_components).toHaveLength(2)
    expect(res.raw_meta_data.unknown_components).toEqual([
      { type: 'UNKNOWN_FUTURE_TYPE', data: 'experimental' },
    ])
  })
})
