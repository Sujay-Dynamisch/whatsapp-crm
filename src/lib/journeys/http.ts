// ============================================================
// HTTP Request step (migration 054).
//
// Account-controlled URL, headers and body, sent from our server — so
// the same SSRF rules as outbound webhooks apply (lib/webhooks/ssrf):
// private / loopback / link-local destinations are refused, redirects
// are not followed (a public URL could bounce to an internal one), the
// request is time-boxed and the response size is capped.
// ============================================================

import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

import type { NodeConfigs } from './graph';
import { renderJsonTemplate, renderTemplate, type ExprScope } from './expressions';

export interface HttpOutput {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
}

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEPT_HEADERS = ['content-type', 'location', 'retry-after', 'x-request-id', 'etag', 'link'];
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);

export class HttpStepError extends Error {
  constructor(
    message: string,
    readonly output: HttpOutput | null
  ) {
    super(message);
    this.name = 'HttpStepError';
  }
}

/** Build the request from the step config + scope (no network). */
export function buildRequest(cfg: NodeConfigs['http_request'], scope: ExprScope): { url: string; init: RequestInit } {
  const rawUrl = renderTemplate(String(cfg.url ?? '').trim(), scope).trim();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpStepError(`"${rawUrl}" is not a valid URL`, null);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new HttpStepError('Only http:// and https:// URLs are allowed', null);
  }
  for (const q of cfg.query ?? []) {
    if (q.key?.trim()) url.searchParams.append(renderTemplate(q.key, scope), renderTemplate(q.value ?? '', scope));
  }

  const headers = new Headers();
  for (const h of cfg.headers ?? []) {
    const name = renderTemplate(h.key ?? '', scope).trim();
    if (!name || BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    try {
      headers.set(name, renderTemplate(h.value ?? '', scope));
    } catch {
      throw new HttpStepError(`Header "${name}" has an invalid name or value`, null);
    }
  }

  const method = cfg.method ?? 'GET';
  let body: string | undefined;
  if (method !== 'GET' && cfg.body_type && cfg.body_type !== 'none') {
    if (cfg.body_type === 'json') {
      // Inside quotes values are escaped (a reply containing `"` can't
      // break the body); standing alone they are embedded as JSON.
      body = renderJsonTemplate(cfg.body ?? '', scope);
      try {
        JSON.parse(body);
      } catch {
        throw new HttpStepError('The JSON body is not valid JSON after filling in the variables', null);
      }
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    } else if (cfg.body_type === 'form') {
      const form = new URLSearchParams();
      for (const f of cfg.form ?? []) {
        if (f.key?.trim()) form.append(renderTemplate(f.key, scope), renderTemplate(f.value ?? '', scope));
      }
      body = form.toString();
      if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded');
    } else {
      body = renderTemplate(cfg.body ?? '', scope);
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
    }
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'wacrm-journeys/1.0');

  return { url: url.toString(), init: { method, headers, body } };
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HttpStepError('The response is larger than 1 MB', null);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Run the request. Resolves with the output for any HTTP status; throws
 * HttpStepError (with the output when there was a response) for non-2xx,
 * blocked destinations and network failures — the engine routes that to
 * the step's "error" output.
 */
export async function runHttpRequest(
  cfg: NodeConfigs['http_request'],
  scope: ExprScope,
  fetchImpl: HttpFetch = fetch,
  checkUrl: (url: string) => Promise<boolean> = isDeliverableUrl
): Promise<HttpOutput> {
  const { url, init } = buildRequest(cfg, scope);
  if (!(await checkUrl(url))) {
    throw new HttpStepError('This destination is not allowed (private or internal address)', null);
  }

  const timeoutMs = Math.min(30, Math.max(1, Number(cfg.timeout_s) || 15)) * 1000;
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError' ? `No response within ${timeoutMs / 1000}s` : `Request failed: ${err instanceof Error ? err.message : String(err)}`;
    throw new HttpStepError(msg, null);
  }

  const text = await readCapped(res);
  const contentType = res.headers.get('content-type') ?? '';
  let body: unknown = text;
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const headers: Record<string, string> = {};
  for (const h of KEPT_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers[h] = v;
  }
  const output: HttpOutput = { status: res.status, ok: res.ok, headers, body };
  if (!res.ok) throw new HttpStepError(`Server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, output);
  return output;
}
