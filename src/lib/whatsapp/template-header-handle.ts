import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import { MEDIA_HEADER_SPECS, isMediaHeaderKind } from '@/lib/whatsapp/media-header-types'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

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

// One message for the SSRF-guard refusal and a genuinely unreachable
// host, across all three media kinds — see the guard comment below.
const UNREACHABLE_MESSAGE =
  'Could not fetch the header media URL. Make sure it is publicly reachable.'

async function fetchUrlHandle(
  url: string,
  kind: 'image' | 'video' | 'document',
  accessToken: string,
  overrideAppId?: string,
): Promise<string> {
  const spec = MEDIA_HEADER_SPECS[kind]
  const appId = overrideAppId || process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID
  if (!appId) {
    throw new Error(
      'Media-header templates need META_APP_ID set (used for Meta’s Resumable Upload). Add it to your environment, or remove the media header.',
    )
  }

  if (!(await isDeliverableUrl(url))) {
    throw new Error(UNREACHABLE_MESSAGE)
  }

  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(UNREACHABLE_MESSAGE)
  }
  if (!res.ok) {
    throw new Error(`Header ${kind} URL returned ${res.status}. It must be publicly reachable.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !spec.mimeTypes.includes(contentType)) {
    throw new Error(`Header ${kind} must be ${spec.formats} (got ${contentType}).`)
  }

  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.byteLength === 0) {
    throw new Error(`Header ${kind} is empty.`)
  }
  if (bytes.byteLength > spec.maxBytes) {
    throw new Error(
      `Header ${kind} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — Meta's limit is ${spec.maxBytes / 1024 / 1024} MB.`,
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
