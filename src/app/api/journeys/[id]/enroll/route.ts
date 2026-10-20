// ============================================================
// POST /api/journeys/[id]/enroll   { tag_id } | { contact_ids: [] }
// (migration 050). Manually start contacts on an active journey.
// Contacts are resolved through the caller's RLS client (so they are
// the caller's account's), then enrolled by the engine (service role).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { enrollContact, startContext, type JourneyRow } from '@/lib/journeys/engine';
import { liveJourneyDeps } from '@/lib/journeys/dispatch';
import { getUnsubscribedContactIds } from '@/lib/contacts/unsubscribe';

export const maxDuration = 300;
const MAX_CONTACTS = 500;

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = await request.json().catch(() => ({}));

    const { data: journey } = await supabase
      .from('journeys')
      .select('*')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!journey) return NextResponse.json({ error: 'Journey not found' }, { status: 404 });
    if (journey.status !== 'active') {
      return NextResponse.json({ error: 'Activate the journey before enrolling contacts' }, { status: 409 });
    }

    let contactIds: string[] = [];
    if (typeof body?.tag_id === 'string' && UUID_RE.test(body.tag_id)) {
      const { data } = await supabase
        .from('contact_tags')
        .select('contact_id, contacts!inner(account_id)')
        .eq('tag_id', body.tag_id)
        .eq('contacts.account_id', accountId)
        .limit(MAX_CONTACTS + 1);
      contactIds = (data ?? []).map((r) => r.contact_id as string);
    } else if (Array.isArray(body?.contact_ids)) {
      const ids = body.contact_ids.filter((x: unknown) => typeof x === 'string' && UUID_RE.test(x));
      for (let i = 0; i < ids.length && i < MAX_CONTACTS + 1; i += 50) {
        const { data } = await supabase
          .from('contacts')
          .select('id')
          .eq('account_id', accountId)
          .in('id', ids.slice(i, i + 50));
        contactIds.push(...(data ?? []).map((c) => c.id as string));
      }
    } else {
      return NextResponse.json({ error: 'Provide tag_id or contact_ids' }, { status: 400 });
    }

    if (contactIds.length > MAX_CONTACTS) {
      return NextResponse.json(
        { error: `At most ${MAX_CONTACTS} contacts per enrollment — split it up` },
        { status: 400 }
      );
    }

    const unsubscribed = await getUnsubscribedContactIds(supabase, accountId);
    const db = supabaseAdmin();
    let enrolled = 0;
    let skipped = 0;
    for (const contactId of [...new Set(contactIds)]) {
      if (unsubscribed.has(contactId)) {
        skipped++;
        continue;
      }
      const r = await enrollContact(db, journey as JourneyRow, contactId, liveJourneyDeps, startContext('manual'));
      if (r.enrolled) enrolled++;
      else skipped++;
    }
    return NextResponse.json({ enrolled, skipped });
  } catch (error) {
    return toErrorResponse(error);
  }
}
