// ============================================================
// POST /api/failed-messages/registrations/[id]
//   { action: 'add', phone }  — fix the number: create the contact (with
//                               the source's tag) and start their journey
//   { action: 'dismiss' }
// Agents and up.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { findOrCreateContact, setContactTags } from '@/lib/api/v1/contacts';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { dispatchJourneyTrigger, restartJourneysOnReregistration } from '@/lib/journeys/dispatch';
import { toInternationalPhone } from '@/lib/lead-sync/registrations';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { id } = await params;
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    const body = (await request.json().catch(() => ({}))) as { action?: string; phone?: string };

    const { data: issue } = await supabase.from('lead_sync_issues').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
    if (!issue) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (issue.resolved) return NextResponse.json({ error: 'Already handled' }, { status: 409 });

    const db = supabaseAdmin();
    const now = new Date().toISOString();
    if (body.action === 'dismiss') {
      await db.from('lead_sync_issues').update({ resolved: 'dismissed', resolved_at: now }).eq('id', id).eq('account_id', accountId);
      return NextResponse.json({ ok: true });
    }
    if (body.action !== 'add') return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const phone = toInternationalPhone(body.phone);
    if (!phone) {
      return NextResponse.json({ error: 'Enter a valid WhatsApp number (10-digit Indian mobile, or +country code)' }, { status: 400 });
    }
    const email = String(issue.email ?? '').trim();
    const { id: contactId, created } = await findOrCreateContact(db, accountId, userId, {
      phone,
      name: issue.name ?? undefined,
      email: email.includes('@') ? email : undefined,
    });
    const reg = { registration_id: issue.registration_id as string, registered_at: (issue.registered_at as string) ?? now };
    if (created) {
      const { data: src } = await db.from('lead_sync_sources').select('tag').eq('account_id', accountId).maybeSingle();
      if (src?.tag) await setContactTags(db, accountId, userId, contactId, [src.tag as string]);
      await dispatchJourneyTrigger(db, { accountId, contactId, trigger: 'contact_created', source: 'api', data: { source: 'api', ...reg } });
    } else {
      // Already a contact under that number: treat it as registering again.
      await restartJourneysOnReregistration(db, {
        accountId,
        contactId,
        registrationId: reg.registration_id,
        registeredAt: new Date().toISOString(),
      });
    }
    await db.from('lead_sync_issues').update({ resolved: 'added', resolved_at: now, contact_id: contactId }).eq('id', id).eq('account_id', accountId);
    return NextResponse.json({ ok: true, contactId, created });
  } catch (error) {
    return toErrorResponse(error);
  }
}
