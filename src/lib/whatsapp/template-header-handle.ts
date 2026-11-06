import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import { MEDIA_HEADER_SPECS, isMediaHeaderKind } from '@/lib/whatsapp/media-header-types'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with a media header — IMAGE, VIDEO or
 * DOCUMENT alike. A plain public URL is not accepted at creation time
 * and fails with "Invalid parameter" (#230 for images, #562 for the
 * other two). This helper turns the template's `header_media_url`
 * (whether the user uploaded a file or pasted a link) into a handle and
 * writes it onto the payload, so both the upload path and the legacy URL
 * path actually succeed.
 *
 * No-op unless the header is a media header that has a URL but no handle
 * yet. Accepted formats and size ceilings per kind live in
 * `media-header-types.ts` and mirror Meta's Cloud API media reference.
 */

const t = getT('Validation.templates')

// One message for the SSRF-guard refusal and a genuinely unreachable
// host, across all three media kinds — see the guard comment below.
const unreachableMessage = () => t('headerUrlUnreachable')

async function fetchUrlHandle(
  url: string,
  kind: 'image' | 'video' | 'document',
  accessToken: string,
  overrideAppId?: string,
): Promise<string> {
  const spec = MEDIA_HEADER_SPECS[kind]
  const appId = overrideAppId || process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID
  if (!appId) {
    throw new Error(t('metaAppIdRequired'))
  }

  // SSRF guard: `header_media_url` is caller-supplied (any authenticated
  // member can submit a template) and the fetch below happens server-side,
  // so refuse any destination that resolves to a private / loopback /
  // link-local / reserved address. Same guard as the two other
  // outbound-fetch call sites (see lib/webhooks/ssrf.ts) — matching the
  // unreachable-host message keeps the failure from being an oracle.
  if (!(await isDeliverableUrl(url))) {
    throw new Error(unreachableMessage())
  }

  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(unreachableMessage())
  }
  if (!res.ok) {
    throw new Error(t('headerUrlStatus', { kind, status: res.status }))
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !spec.mimeTypes.includes(contentType)) {
    throw new Error(t('headerWrongType', { kind, formats: spec.formats, contentType }))
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(t('headerEmpty', { kind }))
  }
  if (bytes.byteLength > spec.maxBytes) {
    throw new Error(
      t('headerTooLarge', {
        kind,
        size: (bytes.byteLength / 1024 / 1024).toFixed(1),
        max: spec.maxBytes / 1024 / 1024,
      }),
    )
  }

  const mimeType = spec.mimeTypes.includes(contentType) ? contentType : spec.mimeTypes[0]
  const fileName = `header.${spec.extensions[mimeType]}`

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })

  return handle
}

export async function ensureMediaHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
  appId?: string,
): Promise<void> {
  const kind = payload.header_type
  if (isMediaHeaderKind(kind) && !payload.header_handle && payload.header_media_url) {
    payload.header_handle = await fetchUrlHandle(payload.header_media_url, kind, accessToken, appId)
  }

  if ((payload.template_type === 'carousel' || payload.carousel) && Array.isArray(payload.carousel)) {
    for (let i = 0; i < payload.carousel.length; i++) {
      const card = payload.carousel[i]
      const format = card.header_format
      if (format === 'IMAGE' || format === 'VIDEO') {
        const cardKind = format === 'IMAGE' ? 'image' : 'video'
        if (!card.header_handle && card.header_media_url) {
          card.header_handle = await fetchUrlHandle(card.header_media_url, cardKind, accessToken, appId)
        }
      }
    }
  }
}
