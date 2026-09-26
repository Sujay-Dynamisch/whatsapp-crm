import type { CarouselCard, TemplateButton, TemplateSampleValues } from '@/types'
import { normalizeStatus } from './template-status-normalize'

export interface MetaTemplateComponent {
  type: string
  format?: string
  text?: string
  buttons?: MetaButton[]
  cards?: { components?: MetaTemplateComponent[] }[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    header_url?: string[]
    body_text?: string[][]
  }
  [key: string]: unknown
}

export interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
  [key: string]: unknown
}

export interface RawMetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
  [key: string]: unknown
}

export function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
    }
  }
  return out
}

const KNOWN_COMPONENT_TYPES = new Set(['BODY', 'HEADER', 'FOOTER', 'BUTTONS', 'CAROUSEL'])

export function normalizeMetaTemplate(raw: RawMetaTemplate): {
  template_type: 'standard' | 'carousel'
  carousel: CarouselCard[] | null
  header_type: 'text' | 'image' | 'video' | 'document' | null
  header_content: string | null
  header_handle: string | null
  header_media_url: string | null
  body_text: string
  footer_text: string | null
  buttons: TemplateButton[] | null
  sample_values: TemplateSampleValues | null
  status: string
  meta_template_id: string
  category: 'Marketing' | 'Utility' | 'Authentication'
  raw_components: MetaTemplateComponent[]
  raw_meta_data: Record<string, unknown>
} {
  const components = Array.isArray(raw.components) ? raw.components : []
  const unknownComponents: MetaTemplateComponent[] = []

  components.forEach((comp) => {
    if (comp?.type && !KNOWN_COMPONENT_TYPES.has(comp.type.toUpperCase())) {
      unknownComponents.push(comp)
      console.warn(`[template-normalize] Unknown Meta component type encountered: "${comp.type}" in template "${raw.name}"`)
    }
  })

  const bodyComp = components.find((c) => c.type?.toUpperCase() === 'BODY')
  const headerComp = components.find((c) => c.type?.toUpperCase() === 'HEADER')
  const footerComp = components.find((c) => c.type?.toUpperCase() === 'FOOTER')
  const buttonsComp = components.find((c) => c.type?.toUpperCase() === 'BUTTONS')
  const carouselComp = components.find((c) => c.type?.toUpperCase() === 'CAROUSEL')

  const isCarousel = Boolean(carouselComp?.cards && carouselComp.cards.length > 0)

  let carouselCards: CarouselCard[] | null = null
  if (isCarousel && carouselComp?.cards) {
    carouselCards = carouselComp.cards.map((card, idx) => {
      const cardComps = Array.isArray(card.components) ? card.components : []
      const cardHeader = cardComps.find((c) => c.type?.toUpperCase() === 'HEADER')
      const cardBody = cardComps.find((c) => c.type?.toUpperCase() === 'BODY')
      const cardBtns = cardComps.find((c) => c.type?.toUpperCase() === 'BUTTONS')

      const headerFormatRaw = cardHeader?.format?.toUpperCase()
      const headerFormat = (headerFormatRaw === 'IMAGE' || headerFormatRaw === 'VIDEO' || headerFormatRaw === 'PRODUCT_CORNER')
        ? headerFormatRaw
        : 'PRODUCT_CORNER'

      const bodySample = cardBody?.example?.body_text?.[0]

      return {
        card_index: idx,
        header_format: headerFormat,
        header_media_url: cardHeader?.example?.header_url?.[0],
        header_handle: cardHeader?.example?.header_handle?.[0],
        body_text: cardBody?.text ?? '',
        buttons: parseButtons(cardBtns?.buttons),
        sample_values: bodySample?.length ? { body: bodySample } : undefined,
        components: cardComps,
        raw_data: card as unknown as Record<string, unknown>,
      }
    })
  }

  const parsedButtons = parseButtons(buttonsComp?.buttons)
  const bodySample = bodyComp?.example?.body_text?.[0]
  const headerSample = headerComp?.example?.header_text
  const sampleValues: TemplateSampleValues | null =
    (bodySample?.length || headerSample?.length)
      ? {
          ...(bodySample?.length && { body: bodySample }),
          ...(headerSample?.length && { header: headerSample }),
        }
      : null

  const headerFormatRaw = headerComp?.format?.toUpperCase()
  const headerType =
    headerFormatRaw === 'TEXT' ||
    headerFormatRaw === 'IMAGE' ||
    headerFormatRaw === 'VIDEO' ||
    headerFormatRaw === 'DOCUMENT'
      ? (headerFormatRaw.toLowerCase() as 'text' | 'image' | 'video' | 'document')
      : null

  const categoryUpper = (raw.category ?? '').toUpperCase()
  const category: 'Marketing' | 'Utility' | 'Authentication' =
    categoryUpper === 'UTILITY' ? 'Utility' : categoryUpper === 'AUTHENTICATION' ? 'Authentication' : 'Marketing'

  return {
    template_type: isCarousel ? 'carousel' : 'standard',
    carousel: carouselCards,
    header_type: headerType,
    header_content: headerComp?.text ?? null,
    header_handle: headerComp?.example?.header_handle?.[0] ?? null,
    header_media_url: headerComp?.example?.header_url?.[0] ?? null,
    body_text: bodyComp?.text ?? '',
    footer_text: footerComp?.text ?? null,
    buttons: parsedButtons.length ? parsedButtons : null,
    sample_values: sampleValues,
    status: normalizeStatus(raw.status),
    meta_template_id: String(raw.id),
    category,
    raw_components: components,
    raw_meta_data: {
      ...raw,
      ...(unknownComponents.length > 0 && { unknown_components: unknownComponents }),
    },
  }
}
