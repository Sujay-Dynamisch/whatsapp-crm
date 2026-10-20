// ============================================================
// POST|GET /api/journeys/hooks/[token]   (migration 054)
//
// Public entry point of a journey with a webhook trigger. External
// systems (Shopify, a website form, Zapier, your own backend) send the
// customer here; the 192-bit token in the path is the credential, so
// it is compared by exact lookup and never logged. JSON, form posts and
// GET query strings are accepted and exposed to the journey as
// {{ trigger.body }} / {{ trigger.query }}.
// ============================================================

import { NextResponse } from 'next/server';

import { accountHasFeature } from '@/lib/features-server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit } from '@/lib/rate-limit';
import { WEBHOOK_TOKEN_RE } from '@/lib/journeys/api';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';
import type { JourneyRow } from '@/lib/journeys/engine';
import { enrollFromWebhook } from '@/lib/journeys/webhook-trigger';

export const maxDuration = 60;

const MAX_BODY_BYTES = 256 * 1024;
/** Request headers worth exposing; credentials never are. */
const EXPOSED_HEADER = /^(content-type|user-agent|x-[a-z0-9-]+)$/i;
const HIDDEN_HEADER = /(authorization|cookie|token|secret|signature|api-key)/i;

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new Error('too_large');
  if (!text) return {};
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function handle(request: Request, token: string) {
  if (!WEBHOOK_TOKEN_RE.test(token)) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const limit = checkRateLimit(`journey-hook:${token}`, { limit: 120, windowMs: 60_000 });
  if (!limit.success) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const db = supabaseAdmin();
  const { data: journey } = await db.from('journeys').select('*').eq('webhook_token', token).maybeSingle();
  if (!journey || journey.trigger_type !== 'webhook') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (journey.status !== 'active') {
    return NextResponse.json({ error: 'This journey is not active' }, { status: 409 });
  }
  if (!(await accountHasFeature(db, journey.account_id, 'journeys'))) {
    return NextResponse.json({ error: 'Journeys are disabled for this account' }, { status: 403 });
  }

  let body: unknown = {};
  if (request.method !== 'GET') {
    try {
      body = await readBody(request);
    } catch {
      return NextResponse.json({ error: 'Body is larger than 256 KB' }, { status: 413 });
    }
  }
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (EXPOSED_HEADER.test(key) && !HIDDEN_HEADER.test(key)) headers[key.toLowerCase()] = value.slice(0, 500);
  });

  const result = await enrollFromWebhook(
    db,
    journey as JourneyRow,
    { body, query: Object.fromEntries(url.searchParams), headers, method: request.method },
    liveJourneyDeps
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({
    ok: true,
    contact_id: result.contactId,
    started: result.enrolled,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.outcome ? { outcome: result.outcome } : {}),
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token);
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token);
}
