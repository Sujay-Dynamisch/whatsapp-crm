// GET /api/not-on-whatsapp — leads whose number is not on WhatsApp
// (src/lib/contacts/not-on-whatsapp.ts), for callers to phone and ask for
// their WhatsApp number. Callers see only their own leads (RLS on
// contacts, migration 086); owners / admins see all.
import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { NOT_ON_WHATSAPP_TAG, UNDELIVERABLE_CODE } from '@/lib/contacts/not-on-whatsapp';
import { restartSteps } from '@/lib/contacts/whatsapp-restart';
import { fetchAll } from '@/lib/supabase/fetch-all';

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const admin = supabaseAdmin();
    const { data: tag } = await admin.from('tags').select('id').eq('account_id', accountId).ilike('name', NOT_ON_WHATSAPP_TAG).maybeSingle();
    const steps = await restartSteps(admin, accountId);
    if (!tag) return NextResponse.json({ leads: [], steps });

    // Through the user's client: RLS limits callers to their own leads.
    const rows = await fetchAll((lo, hi) =>
      supabase
        .from('contacts')
        .select('id, name, phone, assigned_caller_id, contact_tags!inner(tag_id, created_at)')
        .eq('account_id', accountId)
        .eq('contact_tags.tag_id', tag.id)
        .order('id')
        .range(lo, hi)
    );
    const ids = rows.map((r) => r.id as string);
    const fails = new Map<string, { count: number; last: string }>();
    for (let i = 0; i < ids.length; i += 300) {
      const part = await fetchAll((lo, hi) =>
        admin
          .from('journey_messages')
          .select('contact_id, created_at')
          .in('contact_id', ids.slice(i, i + 300))
          .eq('status', 'failed')
          .eq('error_code', UNDELIVERABLE_CODE)
          .order('id')
          .range(lo, hi)
      );
      for (const f of part) {
        const cur = fails.get(f.contact_id as string) ?? { count: 0, last: '' };
        cur.count++;
        if (String(f.created_at) > cur.last) cur.last = String(f.created_at);
        fails.set(f.contact_id as string, cur);
      }
    }
    const callerIds = [...new Set(rows.map((r) => r.assigned_caller_id).filter(Boolean))] as string[];
    const { data: profs } = callerIds.length
      ? await admin.from('profiles').select('user_id, full_name').in('user_id', callerIds)
      : { data: [] };
    const names = new Map((profs ?? []).map((p) => [p.user_id as string, (p.full_name as string) || '']));

    const leads = rows
      .map((r) => {
        const t = (Array.isArray(r.contact_tags) ? r.contact_tags[0] : r.contact_tags) as { created_at?: string } | null;
        return {
          contact_id: r.id as string,
          name: (r.name as string | null) ?? null,
          phone: r.phone as string,
          caller_name: r.assigned_caller_id ? names.get(r.assigned_caller_id as string) ?? null : null,
          failed: fails.get(r.id as string)?.count ?? 0,
          marked_at: t?.created_at ?? fails.get(r.id as string)?.last ?? null,
        };
      })
      .sort((a, b) => String(b.marked_at).localeCompare(String(a.marked_at)));
    return NextResponse.json({ leads, steps });
  } catch (error) {
    return toErrorResponse(error);
  }
}
