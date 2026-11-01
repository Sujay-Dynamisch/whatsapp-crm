// ============================================================
// POST /api/failed-messages/actions
//   { keys: ["journey:<id>" | "inbox:<id>", …], action, at?, text? }
// action: resend | schedule (at = ISO time) | cancel_schedule |
//         send_text (text; 24h window must be open) | dismiss
// Agents and up. Returns one result per key.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { actOnFailed, type FailedAction } from '@/lib/failed-messages/service';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';

export const maxDuration = 300;
const ACTIONS: FailedAction[] = ['resend', 'schedule', 'cancel_schedule', 'send_text', 'dismiss'];
const KEY_RE = /^(journey|inbox):[0-9a-f-]{36}$/i;

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const body = (await request.json().catch(() => ({}))) as { keys?: unknown; action?: unknown; at?: unknown; text?: unknown };
    const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)) : [];
    if (!keys.length) return NextResponse.json({ error: 'Choose at least one message' }, { status: 400 });
    if (keys.length > 200) return NextResponse.json({ error: 'At most 200 at a time' }, { status: 400 });
    const action = ACTIONS.find((a) => a === body.action);
    if (!action) return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
    if (action === 'send_text' && (typeof body.text !== 'string' || !body.text.trim())) {
      return NextResponse.json({ error: 'Write the message to send' }, { status: 400 });
    }
    const results = await actOnFailed(
      supabaseAdmin(),
      {
        accountId,
        userId,
        keys,
        action,
        at: typeof body.at === 'string' ? body.at : undefined,
        text: typeof body.text === 'string' ? body.text : undefined,
      },
      liveJourneyDeps
    );
    return NextResponse.json({ results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  } catch (error) {
    return toErrorResponse(error);
  }
}
