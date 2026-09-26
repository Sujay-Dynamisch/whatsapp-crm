/**
 * Build the Meta `components` array used by POST /{phone_number_id}/messages
 * when sending an APPROVED template.
 *
 * Distinct from `template-components.ts` — that module builds the
 * `components` for TEMPLATE CREATION (where you describe headers,
 * footers, buttons, examples). This module builds the per-send
 * `components` (where you fill in variable values and supply the
 * actual media link or button URL suffix for THIS specific delivery).
 *
 * Auto-fills as much as possible from the template row so callers
 * only need to supply values for the variable-bearing fields:
 *
 *   - Static IMAGE/VIDEO/DOCUMENT headers ride along automatically
 *     using the template's `header_media_url` (or `header_handle`).
 *     Meta requires the media component on every send even though
 *     the URL hasn't changed since approval.
 *   - TEXT headers with `{{1}}` need `headerText` from the caller.
 *   - Body variables come in as `body: string[]`, indexed by {{N}}.
 *   - URL buttons with `{{1}}` need `buttonUrlParams[i]` keyed by
 *     button index. URL buttons without variables, plus QUICK_REPLY
 *     and PHONE_NUMBER buttons, don't need send-time parameters.
 *   - COPY_CODE buttons need the actual code to display. We fall
 *     back to the template's `example` value if the caller doesn't
 *     override — that matches the most common use case (a static
 *     promo code) without forcing UI work.
 *
 * Validation throws here (not at the Meta API boundary) so a missing
 * sample surfaces as "Header text variable {{1}} requires a value",
 * not a 400 from Meta that doesn't say which field broke.
 */

import type { MessageTemplate, TemplateButton } from '@/types';
import { extractVariableIndices, isCarouselTemplate } from './template-validators';
import { normalizeMetaTemplate, type MetaTemplateComponent } from './template-normalize';

export interface SendTimeCardParams {
  cardIndex: number;
  catalogId?: string;
  productRetailerId?: string;
  headerMediaUrl?: string;
  headerMediaId?: string;
  body?: string[];
  buttonParams?: Record<number, string>;
}

export interface SendTimeParams {
  /** Values for body {{1}}, {{2}}, … indexed by variable position. */
  body?: string[];
  /** Value for TEXT-header {{1}}, when the header has a variable. */
  headerText?: string;
  /** Override the template's static media URL for this send. */
  headerMediaUrl?: string;
  /** Alternative: send the media by Meta media id (from prior upload). */
  headerMediaId?: string;
  /**
   * Per-button overrides keyed by the button's index in the
   * template's `buttons` array. Used for URL buttons with a {{1}}
   * suffix and for COPY_CODE buttons whose example you want to
   * override at send time.
   */
  buttonParams?: Record<number, string>;
  /** Per-card send params for carousel templates. */
  carouselCards?: SendTimeCardParams[];
}

export interface MetaSendCarouselCard {
  card_index: number;
  components: MetaSendComponent[];
}

export type MetaSendComponent =
  | { type: 'header'; parameters: MetaSendParameter[] }
  | { type: 'body'; parameters: MetaSendParameter[] }
  | {
      type: 'button';
      sub_type: 'url' | 'quick_reply' | 'copy_code';
      index: string;
      parameters: MetaSendParameter[];
    }
  | {
      type: 'carousel';
      cards: MetaSendCarouselCard[];
    };

type MetaSendParameter =
  | { type: 'text'; text: string }
  | { type: 'image'; image: { link?: string; id?: string } }
  | { type: 'video'; video: { link?: string; id?: string } }
  | { type: 'document'; document: { link?: string; id?: string } }
  | { type: 'coupon_code'; coupon_code: string }
  | { type: 'payload'; payload: string }
  | { type: 'product'; product: { catalog_id: string; product_retailer_id: string } };

function buildHeaderComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const headerType = template.header_type;
  if (!headerType) return null;

  if (headerType === 'text') {
    const varCount = extractVariableIndices(template.header_content ?? '').length;
    if (varCount === 0) return null;
    const value = params.headerText;
    if (!value || !value.trim()) {
      throw new Error(
        'Header text variable {{1}} requires a value — pass headerText.',
      );
    }
    return {
      type: 'header',
      parameters: [{ type: 'text', text: value }],
    };
  }

  const link = params.headerMediaUrl ?? template.header_media_url;
  const id = params.headerMediaId;
  if (!link && !id) {
    throw new Error(
      `${headerType} header requires a media link or id at send time — set header_media_url on the template or pass headerMediaUrl/headerMediaId.`,
    );
  }
  const mediaPayload: { link?: string; id?: string } = id ? { id } : { link };
  return {
    type: 'header',
    parameters: [
      headerType === 'image'
        ? { type: 'image', image: mediaPayload }
        : headerType === 'video'
          ? { type: 'video', video: mediaPayload }
          : { type: 'document', document: mediaPayload },
    ],
  };
}

function buildBodyComponent(
  template: MessageTemplate,
  params: SendTimeParams,
): MetaSendComponent | null {
  const varCount = extractVariableIndices(template.body_text).length;
  const body = params.body ?? [];
  if (varCount === 0 && body.length === 0) return null;
  if (body.length < varCount) {
    throw new Error(
      `Body has ${varCount} variable(s) but only ${body.length} value(s) were supplied.`,
    );
  }
  const values = body.slice(0, varCount);
  return {
    type: 'body',
    parameters: values.map((text) => ({ type: 'text', text: String(text) })),
  };
}

function buttonNeedsSendParam(
  button: TemplateButton,
  override: string | undefined,
): boolean {
  switch (button.type) {
    case 'URL':
      return extractVariableIndices(button.url).length > 0;
    case 'COPY_CODE':
      return true;
    case 'QUICK_REPLY':
    case 'PHONE_NUMBER':
      return override !== undefined;
  }
}

function buildButtonComponent(
  button: TemplateButton,
  index: number,
  override: string | undefined,
  bodyParams?: string[],
): MetaSendComponent | null {
  if (!buttonNeedsSendParam(button, override)) return null;

  switch (button.type) {
    case 'URL': {
      let value = override;
      if (!value || !value.trim()) {
        const varIndices = extractVariableIndices(button.url);
        if (varIndices.length > 0 && bodyParams) {
          const varNum = varIndices[0];
          value = bodyParams[varNum - 1];
        }
      }
      if (!value || !value.trim()) {
        throw new Error(
          `URL button #${index + 1} uses {{1}} — requires a buttonParams[${index}] value.`,
        );
      }
      return {
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: value }],
      };
    }
    case 'COPY_CODE': {
      const code = override?.trim() || button.example;
      return {
        type: 'button',
        sub_type: 'copy_code',
        index: String(index),
        parameters: [{ type: 'coupon_code', coupon_code: code }],
      };
    }
    case 'QUICK_REPLY': {
      return {
        type: 'button',
        sub_type: 'quick_reply',
        index: String(index),
        parameters: [{ type: 'payload', payload: override! }],
      };
    }
    case 'PHONE_NUMBER':
      return null;
  }
}

/**
 * Build the full `components` array for the send-message payload.
 * Returns an empty array when the template is fully static (no
 * variables, no media header), which is a valid Meta request.
 */
export function buildSendComponents(
  template: MessageTemplate,
  params: SendTimeParams = {},
): MetaSendComponent[] {
  const out: MetaSendComponent[] = [];

  const isCarousel = isCarouselTemplate(template);
  let carouselCards = template.carousel;
  if (isCarousel && (!carouselCards || carouselCards.length < 2)) {
    const rawComps = (template.raw_components ?? (template as unknown as { components?: MetaTemplateComponent[] }).components) as unknown as MetaTemplateComponent[];
    if (Array.isArray(rawComps) && rawComps.length > 0) {
      const normalized = normalizeMetaTemplate({
        id: template.meta_template_id ?? '',
        name: template.name ?? '',
        language: template.language ?? 'en_US',
        status: template.status ?? 'APPROVED',
        category: template.category ?? 'Marketing',
        components: rawComps,
      });
      if (normalized.carousel && normalized.carousel.length >= 2) {
        carouselCards = normalized.carousel;
      }
    }
  }

  if (isCarousel && carouselCards && carouselCards.length >= 2) {
    if (template.body_text) {
      const body = buildBodyComponent(template, params);
      if (body) out.push(body);
    }

    const carouselCardsPayload: MetaSendCarouselCard[] = carouselCards.map((card, i) => {
      const cardOverride = params.carouselCards?.find((c) => c.cardIndex === i);
      const catalogId = cardOverride?.catalogId ?? card.catalog_id;
      const retailerId = cardOverride?.productRetailerId ?? card.product_retailer_id;
      const cardComponents: MetaSendComponent[] = [];

      const isVideo = card.header_format === 'VIDEO';
      const isProduct = card.header_format === 'PRODUCT_CORNER' || Boolean(retailerId);

      if (isProduct && retailerId) {
        const prodObj: { product_retailer_id: string; catalog_id?: string } = {
          product_retailer_id: retailerId,
        };
        if (catalogId) prodObj.catalog_id = catalogId;
        cardComponents.push({
          type: 'header',
          parameters: [
            {
              type: 'product',
              product: prodObj as { catalog_id: string; product_retailer_id: string },
            },
          ],
        });
      } else {
        // Media card carousel header (IMAGE or VIDEO)
        const mediaUrl =
          cardOverride?.headerMediaUrl?.trim() ||
          card.header_media_url?.trim() ||
          params.headerMediaUrl?.trim() ||
          template.header_media_url?.trim() ||
          'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=800';
        const mediaId = cardOverride?.headerMediaId;
        const mediaPayload: { link?: string; id?: string } = mediaId ? { id: mediaId } : { link: mediaUrl };

        cardComponents.push({
          type: 'header',
          parameters: [
            isVideo
              ? { type: 'video', video: mediaPayload }
              : { type: 'image', image: mediaPayload },
          ],
        });
      }

      if (card.body_text) {
        const varIndices = extractVariableIndices(card.body_text);
        if (varIndices.length > 0) {
          const providedBody = cardOverride?.body ?? [];
          const sampleBody = card.sample_values?.body ?? [];
          const values: string[] = [];
          for (let vIdx = 0; vIdx < varIndices.length; vIdx++) {
            const varNum = varIndices[vIdx];
            const valFromOverride = providedBody[vIdx];
            const valFromParams = params.body?.[varNum - 1];
            const valFromSample = sampleBody[vIdx];
            values.push(valFromOverride || valFromParams || valFromSample || `Sample ${vIdx + 1}`);
          }
          cardComponents.push({
            type: 'body',
            parameters: values.map((val) => ({ type: 'text', text: String(val) })),
          });
        }
      }

      if (card.buttons?.length) {
        card.buttons.forEach((btn, btnIdx) => {
          const btnOverride = cardOverride?.buttonParams?.[btnIdx];
          if (btn.type === 'QUICK_REPLY') {
            cardComponents.push({
              type: 'button',
              sub_type: 'quick_reply',
              index: String(btnIdx),
              parameters: [
                {
                  type: 'payload',
                  payload: btnOverride?.trim() || btn.text || `card_${i}_btn_${btnIdx}`,
                },
              ],
            });
          } else {
            const btnComp = buildButtonComponent(btn, btnIdx, btnOverride, params.body);
            if (btnComp) cardComponents.push(btnComp);
          }
        });
      }

      return {
        card_index: i,
        components: cardComponents,
      };
    });

    out.push({
      type: 'carousel',
      cards: carouselCardsPayload,
    });

    return out;
  }

  const header = buildHeaderComponent(template, params);
  if (header) out.push(header);
  const body = buildBodyComponent(template, params);
  if (body) out.push(body);
  if (template.buttons?.length) {
    template.buttons.forEach((btn, i) => {
      const override = params.buttonParams?.[i];
      const component = buildButtonComponent(btn, i, override, params.body);
      if (component) out.push(component);
    });
  }
  return out;
}
