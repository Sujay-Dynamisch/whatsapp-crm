'use client'

// Caller dashboard (caller management, migration 086). A scoped caller
// sees only their own work — every query goes through the RLS client, so
// the database limits it to the caller's own leads, chats and callbacks.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { CheckCircle2, MessageSquare, PhoneCall, Sparkles, UserPlus, Users } from 'lucide-react'

import { createClient } from '@/lib/supabase/client'
import { useRealtime } from '@/hooks/use-realtime'
import { cn } from '@/lib/utils'

interface Contact {
  name: string | null
  phone: string
}
type One<T> = T | T[] | null
const one = <T,>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

interface CallbackRow {
  id: string
  contact_id: string
  conversation_id: string | null
  status: string
  priority: 'normal' | 'high'
  source: string | null
  source_kind: string | null
  requested_at: string
  ai_meta: { requested_time?: string } | null
  contacts: One<Contact>
}
interface ChatRow {
  id: string
  last_message_text: string | null
  last_message_at: string | null
  unread_count: number | null
  contacts: One<Contact>
}
interface Data {
  myLeads: number
  newToday: number
  calls: CallbackRow[]
  openCalls: number
  priority: number
  handledToday: number
  chats: ChatRow[]
  waitingChats: number
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

function startOfToday(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

async function load(userId: string): Promise<Data> {
  const db = createClient()
  const today = startOfToday()
  const [leads, newToday, calls, openCalls, priority, handled, chats, waiting] = await Promise.all([
    db.from('contacts').select('id', { count: 'exact', head: true }).eq('assigned_caller_id', userId),
    db.from('engagements').select('id', { count: 'exact', head: true }).eq('assigned_caller_id', userId).gte('created_at', today),
    db
      .from('callback_requests')
      .select('id, contact_id, conversation_id, status, priority, source, source_kind, requested_at, ai_meta, contacts(name, phone)')
      .neq('status', 'done')
      .order('priority', { ascending: true })
      .order('requested_at', { ascending: true })
      .limit(8),
    db.from('callback_requests').select('id', { count: 'exact', head: true }).neq('status', 'done'),
    db.from('callback_requests').select('id', { count: 'exact', head: true }).neq('status', 'done').eq('priority', 'high'),
    db.from('callback_requests').select('id', { count: 'exact', head: true }).eq('handled_by', userId).gte('handled_at', today),
    db
      .from('conversations')
      .select('id, last_message_text, last_message_at, unread_count, contacts(name, phone)')
      .neq('status', 'closed')
      .gt('unread_count', 0)
      .order('last_message_at', { ascending: true })
      .limit(6),
    db.from('conversations').select('id', { count: 'exact', head: true }).neq('status', 'closed').gt('unread_count', 0),
  ])
  return {
    myLeads: leads.count ?? 0,
    newToday: newToday.count ?? 0,
    calls: (calls.data ?? []) as CallbackRow[],
    openCalls: openCalls.count ?? 0,
    priority: priority.count ?? 0,
    handledToday: handled.count ?? 0,
    chats: (chats.data ?? []) as ChatRow[],
    waitingChats: waiting.count ?? 0,
  }
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
  href,
}: {
  icon: React.ReactNode
  label: string
  value: number
  hint: string
  tone: 'amber' | 'primary' | 'sky' | 'emerald'
  href: string
}) {
  const tones = {
    amber: 'bg-amber-500/12 text-amber-600 dark:text-amber-400',
    primary: 'bg-primary/10 text-primary',
    sky: 'bg-sky-500/12 text-sky-600 dark:text-sky-400',
    emerald: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
  }
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-2xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
    >
      <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', tones[tone])}>{icon}</span>
      <div className="min-w-0">
        <p className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{value}</span>
          <span className="truncate text-sm font-medium text-foreground">{label}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">{hint}</p>
      </div>
    </Link>
  )
}

function Badge({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', className)}>{children}</span>
}

export function CallerDashboard({ userId, name }: { userId: string; name: string | null }) {
  const [data, setData] = useState<Data | null>(null)

  const refresh = useCallback(() => {
    load(userId)
      .then(setData)
      .catch((err) => console.error('[caller-dashboard] load failed:', err))
  }, [userId])

  useEffect(() => {
    void Promise.resolve().then(refresh)
    const t = window.setInterval(() => document.visibilityState === 'visible' && refresh(), 60_000)
    return () => window.clearInterval(t)
  }, [refresh])

  useRealtime({ channelName: 'caller-dashboard', onMessageEvent: refresh, onConversationEvent: refresh })

  useEffect(() => {
    const db = createClient()
    const ch = db
      .channel('caller-dashboard-callbacks')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'callback_requests' }, () => refresh())
      .subscribe()
    return () => {
      void db.removeChannel(ch)
    }
  }, [refresh])

  const first = (name ?? '').trim().split(/\s+/)[0] || 'there'

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">
          {greeting()}, {first}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {data
            ? data.priority > 0
              ? `${data.priority} customer${data.priority === 1 ? ' is' : 's are'} waiting for your call — start with the Priority ones.`
              : data.openCalls > 0
                ? `You have ${data.openCalls} lead${data.openCalls === 1 ? '' : 's'} to call today.`
                : 'You’re all caught up. Nice work!'
            : 'Loading your day…'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<PhoneCall className="size-5" />} tone="amber" label="Priority calls" value={data?.priority ?? 0} hint="Customers who asked you to call" href="/callbacks" />
        <Stat icon={<UserPlus className="size-5" />} tone="primary" label="To call" value={data?.openCalls ?? 0} hint={`${data?.newToday ?? 0} new lead${data?.newToday === 1 ? '' : 's'} assigned today`} href="/callbacks" />
        <Stat icon={<MessageSquare className="size-5" />} tone="sky" label="Chats waiting" value={data?.waitingChats ?? 0} hint="Your leads waiting for a reply" href="/inbox" />
        <Stat icon={<CheckCircle2 className="size-5" />} tone="emerald" label="Handled today" value={data?.handledToday ?? 0} hint={`${data?.myLeads ?? 0} leads in your list`} href="/contacts" />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="font-semibold text-foreground">Your call list</h2>
              <p className="text-xs text-muted-foreground">Priority first, then the oldest.</p>
            </div>
            <Link href="/callbacks" className="text-xs font-medium text-primary hover:underline">
              Open Callbacks
            </Link>
          </div>
          {!data ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : data.calls.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <CheckCircle2 className="size-8 text-emerald-500" />
              <p className="text-sm text-muted-foreground">No calls waiting. New leads will show up here.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.calls.map((r) => {
                const c = one(r.contacts)
                return (
                  <li key={r.id} className={cn('flex items-center gap-3 px-4 py-3', r.priority === 'high' && 'bg-amber-500/5')}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate font-medium text-foreground">{c?.name || c?.phone || 'Unknown'}</p>
                        {r.priority === 'high' && <Badge className="bg-amber-500 text-white">Priority</Badge>}
                        {r.source_kind === 'engagement' && r.priority !== 'high' && (
                          <Badge className="border border-border text-muted-foreground">New lead</Badge>
                        )}
                        {r.source_kind === 'ai_inbox_text' && (
                          <Badge className="border border-violet-500/40 text-violet-700 dark:text-violet-300">
                            <Sparkles className="mr-0.5 inline size-3" />
                            Typed request{r.ai_meta?.requested_time && !/ASAP/i.test(r.ai_meta.requested_time) ? ` · ${r.ai_meta.requested_time}` : ''}
                          </Badge>
                        )}
                        {r.status === 'no_answer' && <Badge className="border border-rose-500/40 text-rose-600 dark:text-rose-400">No answer</Badge>}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.source && r.source_kind !== 'engagement' ? `“${r.source}” · ` : ''}
                        {formatDistanceToNow(new Date(r.requested_at), { addSuffix: true })}
                      </p>
                    </div>
                    {c?.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        <PhoneCall className="size-3.5" /> Call
                      </a>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="font-semibold text-foreground">Chats waiting for you</h2>
              <p className="text-xs text-muted-foreground">Longest wait first.</p>
            </div>
            <Link href="/inbox" className="text-xs font-medium text-primary hover:underline">
              Open inbox
            </Link>
          </div>
          {!data ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
          ) : data.chats.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <Users className="size-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No unread chats from your leads.</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.chats.map((ch) => {
                const c = one(ch.contacts)
                return (
                  <li key={ch.id}>
                    <Link href={`/inbox?c=${ch.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">{c?.name || c?.phone || 'Unknown'}</p>
                        <p className="truncate text-xs text-muted-foreground">{ch.last_message_text || '—'}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">{ch.unread_count}</span>
                        {ch.last_message_at && (
                          <p className="mt-1 text-[11px] text-muted-foreground">{formatDistanceToNow(new Date(ch.last_message_at), { addSuffix: true })}</p>
                        )}
                      </div>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
