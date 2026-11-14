// Shared by the payment-ledger API routes (migration 095).

import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { UUID_RE } from '@/lib/journeys/api';
import { PAYMENT_METHODS } from '@/lib/payments/ledger';
import { loadTracking } from '@/lib/payments/tracking';

export async function guard(contactId: string, write: boolean) {
  const ctx = write ? await requireRole('agent') : await getCurrentAccount();
  if (!UUID_RE.test(contactId)) return { error: NextResponse.json({ error: 'Invalid id' }, { status: 400 }) } as const;
  const tracking = await loadTracking(ctx.supabase, ctx.accountId);
  if (!tracking) return { error: NextResponse.json({ error: 'not_enabled' }, { status: 404 }) } as const;
  // RLS client: a scoped caller (086) only sees their own leads.
  const { data: contact } = await ctx.supabase
    .from('contacts')
    .select('id, name, phone')
    .eq('id', contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (!contact) return { error: NextResponse.json({ error: 'Contact not found' }, { status: 404 }) } as const;
  const { data: profile } = await ctx.supabase.from('profiles').select('full_name').eq('user_id', ctx.userId).maybeSingle();
  const who = (profile?.full_name as string | null)?.trim() || 'a team member';
  return { ctx, tracking, contact, who, db: supabaseAdmin() } as const;
}

export function parsePayment(body: Record<string, unknown>, partial = false) {
  const out: Record<string, unknown> = {};
  if (!partial || body.amount !== undefined) {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'Enter an amount greater than 0' };
    out.amount = Math.round(amount * 100) / 100;
  }
  if (body.method !== undefined) {
    const m = body.method === null || body.method === '' ? null : String(body.method);
    if (m && !(PAYMENT_METHODS as readonly string[]).includes(m)) return { error: 'Unknown payment method' };
    out.method = m;
  }
  if (body.paid_on !== undefined) {
    const d = String(body.paid_on);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) return { error: 'Choose a valid date' };
    out.paid_on = d;
  }
  if (body.note !== undefined) out.note = String(body.note ?? '').trim().slice(0, 300) || null;
  return { value: out };
}

