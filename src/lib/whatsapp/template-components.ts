/**
 * Translate our local template row shape into the `components` array
 * shape that Meta's POST /{waba_id}/message_templates endpoint expects.
 *
 * Keep this function pure and JSON-shaped — the submit route and the
 * (future) edit route both call it, and unit tests assert the exact
 * payload by snapshot.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

import { extractVariableIndices, type TemplatePayload } from './template-validators';
import type { TemplateButton } from '@/types';

export interface MetaCarouselCardPayload {
  components: MetaComponent[];
}

export interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS' | 'CAROUSEL';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'PRODUCT_CORNER';
  text?: string;
  buttons?: MetaButtonPayload[];
  cards?: MetaCarouselCardPayload[];
  example?: {
    header_text?: string[];
    header_url?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

function buildCarouselComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.carousel || payload.carousel.length < 2) return null;

  const cardsPayload: MetaCarouselCardPayload[] = payload.carousel.map((card) => {
    const cardComponents: MetaComponent[] = [];
    const headerFormat = card.header_format ?? 'IMAGE';
    const headerComp: MetaComponent = {
      type: 'HEADER',
      format: headerFormat,
    };
    const handle = card.header_handle || card.header_media_url;
    if (headerFormat !== 'PRODUCT_CORNER' && handle) {
      headerComp.example = { header_handle: [handle] };
    }
    cardComponents.push(headerComp);

    if (card.body_text?.trim()) {
      const bodyComp: MetaComponent = {
        type: 'BODY',
        text: card.body_text,
      };
      const vars = extractVariableIndices(card.body_text);
      let bodySample = card.sample_values?.body;
      if (vars.length > 0) {
        if (!bodySample || bodySample.length === 0) {
          bodySample = vars.map((i) => `Sample${i}`);
        }
        bodyComp.example = { body_text: [bodySample] };
      }
      cardComponents.push(bodyComp);
    }

    if (card.buttons && card.buttons.length > 0) {
      cardComponents.push({
        type: 'BUTTONS',
        buttons: card.buttons.map(buildButtonPayload),
      });
    }

    return { components: cardComponents };
  });

  return {
    type: 'CAROUSEL',
    cards: cardsPayload,
  };
}

interface MetaButtonPayload {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE';
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[];
}

function buildHeaderComponent(payload: TemplatePayload): MetaComponent | null {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return null;

  if (header_type === 'text') {
    const headerSample = payload.sample_values?.header;
    const component: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header_content,
    };
    if (headerSample && headerSample.length > 0) {
      component.example = { header_text: headerSample };
    }
    return component;
  }

  const format =
    header_type === 'image'
      ? 'IMAGE'
      : header_type === 'video'
        ? 'VIDEO'
        : 'DOCUMENT';
  const component: MetaComponent = { type: 'HEADER', format };
  if (header_handle) {
    component.example = { header_handle: [header_handle] };
  } else if (header_media_url) {
    component.example = { header_url: [header_media_url] };
  }
  return component;
}

function buildBodyComponent(payload: TemplatePayload): MetaComponent {
  const component: MetaComponent = {
    type: 'BODY',
    text: payload.body_text,
  };
  const vars = extractVariableIndices(payload.body_text || '');
  let bodySample = payload.sample_values?.body;
  if (vars.length > 0) {
    if (!bodySample || bodySample.length === 0) {
      bodySample = vars.map((i) => `Sample${i}`);
    }
    component.example = { body_text: [bodySample] };
  }
  return component;
}

function buildFooterComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.footer_text?.trim()) return null;
  return { type: 'FOOTER', text: payload.footer_text };
}

function buildButtonPayload(b: TemplateButton): MetaButtonPayload {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL': {
      const payload: MetaButtonPayload = {
        type: 'URL',
        text: b.text,
        url: b.url,
      };
      if (b.example) {
        payload.example = [b.example];
      } else if (b.url && extractVariableIndices(b.url).length > 0) {
        payload.example = ['sample'];
      }
      return payload;
    }
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: [b.example] };
  }
}

function buildButtonsComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.buttons || payload.buttons.length === 0) return null;
  return {
    type: 'BUTTONS',
    buttons: payload.buttons.map(buildButtonPayload),
  };
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: MetaComponent[];
}

const CATEGORY_TO_META: Record<
  'Marketing' | 'Utility' | 'Authentication',
  MetaTemplateSubmitPayload['category']
> = {
  Marketing: 'MARKETING',
  Utility: 'UTILITY',
  Authentication: 'AUTHENTICATION',
};

/**
 * Assemble the full submit payload (name + category + language +
 * components in canonical order).
 */
export function buildMetaTemplatePayload(
  payload: TemplatePayload,
): MetaTemplateSubmitPayload {
  const components: MetaComponent[] = [];
  const isCarousel = payload.template_type === 'carousel' || (Array.isArray(payload.carousel) && payload.carousel.length >= 2);

  if (isCarousel) {
    // Meta Carousel Templates MUST ONLY have top-level BODY and CAROUSEL components.
    // Top-level HEADER, FOOTER, and BUTTONS are strictly forbidden by Meta for Carousel templates.
    components.push(buildBodyComponent(payload));

    const carouselComp = buildCarouselComponent(payload);
    if (carouselComp) components.push(carouselComp);
  } else {
    // Standard template
    const header = buildHeaderComponent(payload);
    if (header) components.push(header);
    components.push(buildBodyComponent(payload));
    const footer = buildFooterComponent(payload);
    if (footer) components.push(footer);
    const buttons = buildButtonsComponent(payload);
    if (buttons) components.push(buttons);
  }

  return {
    name: payload.name,
    category: isCarousel ? 'MARKETING' : CATEGORY_TO_META[payload.category],
    language: payload.language,
    components,
  };
}
