'use client';

// Caller management (migration 086): who takes leads, their workload,
// the Admin Unassigned queue and manual reassignment.

import { BulkMoveDialog } from '@/components/callers/bulk-move-dialog';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Inbox,
  Loader2,
  PhoneCall,
  RefreshCw,
  Sparkles,
  UserCheck,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Avatar, AvatarBadge, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { initialsOf } from '@/components/dashboard/initials';
import { Skeleton } from '@/components/dashboard/skeleton';
import { cn } from '@/lib/utils';

interface Member {
  user_id: string;
  full_name: string | null;
  email: string | null;
  account_role: string;
  caller: { status: 'active' | 'inactive'; lead_eligible: boolean; since: string } | null;
  open_leads: number;
  open_callbacks: number;
  priority_callbacks: number;
}
interface Unassigned {
  contact_id: string;
  name: string | null;
  phone: string | null;
  since: string;
  priority: boolean;
}
interface Lead {
  id: string;
  name: string | null;
  phone: string;
}

const UNASSIGNED_VALUE = '__unassigned__';

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export default function CallersPage() {
  const { can } = useAuth();
  const canEdit = can('callers', 'edit');
  const [members, setMembers] = useState<Member[]>([]);
  const [unassigned, setUnassigned] = useState<Unassigned[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [openCaller, setOpenCaller] = useState<string | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);

  const load = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const d = await api<{ members: Member[]; unassigned: Unassigned[] }>('/api/callers');
      setMembers(d.members);
      setUnassigned(d.unassigned);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load callers');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const callers = useMemo(() => members.filter((m) => m.caller), [members]);
  const others = useMemo(() => members.filter((m) => !m.caller), [members]);
  const active = useMemo(() => callers.filter((m) => m.caller!.status === 'active'), [callers]);
  const eligibleCount = useMemo(
    () => active.filter((m) => m.caller!.lead_eligible).length,
    [active]
  );
  const totalOpenLeads = useMemo(
    () => callers.reduce((sum, m) => sum + m.open_leads, 0),
    [callers]
  );
  const totalOpenCallbacks = useMemo(
    () => callers.reduce((sum, m) => sum + m.open_callbacks, 0),
    [callers]
  );
  const priorityUnassignedCount = useMemo(
    () => unassigned.filter((u) => u.priority).length,
    [unassigned]
  );

  const nameOf = (m: Member) => m.full_name || m.email || 'Member';

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(null);
    }
  };

  const showLeads = async (userId: string) => {
    if (openCaller === userId) {
      setOpenCaller(null);
      return;
    }
    setOpenCaller(userId);
    setLeads([]);
    setLeadsLoading(true);
    try {
      setLeads((await api<{ leads: Lead[] }>(`/api/callers/${userId}`)).leads);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load leads');
    } finally {
      setLeadsLoading(false);
    }
  };

  const reassign = (contactId: string, to: string) =>
    run(
      `re-${contactId}`,
      async () => {
        await api('/api/callers/reassign', {
          method: 'POST',
          body: JSON.stringify({ contactId, toCallerId: to || null }),
        });
        setLeads((l) => l.filter((x) => x.id !== contactId));
      },
      to ? 'Lead reassigned' : 'Moved to Admin Unassigned'
    );

  const setStatus = async (m: Member, status: 'active' | 'inactive') => {
    if (status === 'inactive') {
      const ok = await confirmDialog({
        title: `Deactivate ${nameOf(m)}?`,
        description:
          'Their open leads and callbacks move to Admin Unassigned and they stop receiving new leads. Agents/viewers are signed out and cannot sign in until re-activated. History is kept.',
        confirmLabel: 'Deactivate',
        destructive: true,
      });
      if (!ok) return;
    }
    await run(
      `st-${m.user_id}`,
      () => api(`/api/callers/${m.user_id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
      status === 'active' ? 'Caller activated' : 'Caller deactivated'
    );
  };

  const ReassignSelect = ({ contactId, current }: { contactId: string; current: string | null }) => {
    const selectedLabel = current
      ? (() => {
          const found = active.find((c) => c.user_id === current);
          return found ? nameOf(found) : 'Unassigned';
        })()
      : 'Assign caller…';

    return (
      <Select
        disabled={!canEdit || busy === `re-${contactId}`}
        value={current ?? UNASSIGNED_VALUE}
        onValueChange={(val) => {
          const next = val === UNASSIGNED_VALUE || !val ? '' : String(val);
          if (next === (current ?? '')) return;
          void reassign(contactId, next);
        }}
      >
        <SelectTrigger size="sm" className="min-w-36 bg-background text-xs">
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
          {active.map((c) => (
            <SelectItem key={c.user_id} value={c.user_id}>
              {nameOf(c)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
        <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-border/60 p-4 lg:border-b-0 lg:border-r last:border-r-0">
              <Skeleton className="size-9 rounded-lg" />
              <div className="space-y-1.5">
                <Skeleton className="h-5 w-12" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
          <Skeleton className="h-64 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Callers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New website leads rotate across active, lead-eligible callers. A returning lead (after 15 days) goes back to their caller.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <BulkMoveDialog
              callers={callers.map((m) => ({ id: m.user_id, name: nameOf(m), leads: m.open_leads, active: m.caller!.status === 'active' }))}
              unassigned={unassigned.length}
              onDone={() => void load(true)}
            />
          )}
          <Link href="/settings?tab=callbacks" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            Reminder settings
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={refreshing}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', refreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Headline Metrics Strip */}
      <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-border bg-card lg:grid-cols-4">
        {[
          {
            label: 'Active callers',
            value: active.length,
            meta: callers.length > 0 ? `of ${callers.length} total` : 'none configured',
            icon: UserCheck,
            tone: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400',
          },
          {
            label: 'Taking new leads',
            value: eligibleCount,
            meta: active.length > eligibleCount ? `${active.length - eligibleCount} paused` : 'in rotation',
            icon: Sparkles,
            tone: 'bg-primary/12 text-primary',
          },
          {
            label: 'Assigned open leads',
            value: totalOpenLeads,
            meta: `${totalOpenCallbacks} open callbacks`,
            icon: Users,
            tone: 'bg-blue-500/12 text-blue-600 dark:text-blue-400',
          },
          {
            label: 'Admin unassigned',
            value: unassigned.length,
            meta:
              priorityUnassignedCount > 0
                ? `${priorityUnassignedCount} priority waiting`
                : unassigned.length > 0
                  ? 'awaiting owner'
                  : 'queue clear',
            icon: Inbox,
            tone:
              unassigned.length > 0
                ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400'
                : 'bg-muted text-muted-foreground',
          },
        ].map((stat, i) => (
          <div
            key={stat.label}
            className={cn(
              'flex items-center gap-3.5 px-4 py-3.5',
              i % 2 === 1 && 'border-l border-border',
              i >= 2 && 'border-t border-border lg:border-t-0 lg:border-l'
            )}
          >
            <span className={cn('hidden size-9 shrink-0 items-center justify-center rounded-xl sm:flex', stat.tone)}>
              <stat.icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                <p className="text-xl leading-tight font-bold tabular-nums text-foreground">{stat.value}</p>
                <span className="truncate text-[11px] text-muted-foreground">{stat.meta}</span>
              </div>
              <p className="truncate text-xs text-muted-foreground">{stat.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Main Content Split */}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        {/* Callers Roster */}
        <Card>
          <CardHeader className="border-b">
            <div className="flex items-center gap-2.5">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <UserCog className="size-4" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle>Callers</CardTitle>
                  <Badge variant="secondary" className="tabular-nums">
                    {callers.length}
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  Toggle lead eligibility, inspect active workloads, or manage availability.
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {callers.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserPlus className="size-5" />
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">No callers configured yet</p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Add a team member below to begin rotating incoming website leads. Until then, new leads arrive in Admin Unassigned.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {callers.map((m) => {
                  const c = m.caller!;
                  const isActive = c.status === 'active';
                  const isExpanded = openCaller === m.user_id;
                  const displayName = nameOf(m);

                  return (
                    <li key={m.user_id} className="px-4 py-4 transition-colors hover:bg-muted/20 sm:px-5">
                      <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
                        {/* Identity */}
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar size="lg">
                            <AvatarFallback
                              className={cn(
                                'text-xs font-semibold',
                                isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                              )}
                            >
                              {initialsOf(displayName)}
                            </AvatarFallback>
                            <AvatarBadge className={isActive ? 'bg-emerald-500' : 'bg-muted-foreground/45'} />
                          </Avatar>

                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <p className="truncate font-semibold text-foreground">{displayName}</p>
                              <Badge
                                variant="secondary"
                                className={cn(
                                  'text-[11px] font-medium',
                                  isActive
                                    ? 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-400'
                                    : 'bg-muted text-muted-foreground'
                                )}
                              >
                                {isActive ? 'Active' : 'Inactive'}
                              </Badge>
                              {!c.lead_eligible && isActive && (
                                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                                  Paused
                                </Badge>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground">{m.email}</p>
                          </div>
                        </div>

                        {/* Workload & Actions */}
                        <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                          <button
                            type="button"
                            onClick={() => void showLeads(m.user_id)}
                            className={cn(
                              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors tabular-nums',
                              isExpanded
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                            )}
                          >
                            <Users className="size-3.5" />
                            <span>{m.open_leads} leads</span>
                            {isExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                          </button>

                          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground tabular-nums">
                            <PhoneCall className="size-3.5" />
                            <span>{m.open_callbacks} open</span>
                            {m.priority_callbacks > 0 && (
                              <span className="ml-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                                {m.priority_callbacks} priority
                              </span>
                            )}
                          </div>

                          {canEdit && (
                            <>
                              <span className="hidden h-4 w-px bg-border sm:inline-block" />

                              {isActive && (
                                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                                  <Switch
                                    checked={c.lead_eligible}
                                    disabled={busy === `el-${m.user_id}`}
                                    onCheckedChange={(checked) =>
                                      void run(`el-${m.user_id}`, () =>
                                        api(`/api/callers/${m.user_id}`, {
                                          method: 'PATCH',
                                          body: JSON.stringify({ lead_eligible: checked }),
                                        })
                                      )
                                    }
                                  />
                                  <span>Takes new leads</span>
                                </label>
                              )}

                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy === `st-${m.user_id}`}
                                onClick={() => void setStatus(m, isActive ? 'inactive' : 'active')}
                              >
                                {busy === `st-${m.user_id}` && <Loader2 className="mr-1.5 size-3 animate-spin" />}
                                {isActive ? 'Deactivate' : 'Activate'}
                              </Button>

                              <Button
                                size="icon-sm"
                                variant="ghost"
                                aria-label={`Remove ${displayName} as caller`}
                                title={`Remove ${displayName} as caller`}
                                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                disabled={busy === `rm-${m.user_id}`}
                                onClick={async () => {
                                  const ok = await confirmDialog({
                                    title: `Remove ${displayName} as a caller?`,
                                    description:
                                      'Their open leads and callbacks move to Admin Unassigned. They stay a team member.',
                                    confirmLabel: 'Remove',
                                    destructive: true,
                                  });
                                  if (ok) {
                                    await run(
                                      `rm-${m.user_id}`,
                                      () => api(`/api/callers/${m.user_id}`, { method: 'DELETE' }),
                                      'Caller removed'
                                    );
                                  }
                                }}
                              >
                                <UserMinus className="size-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Expandable Open Leads Drawer */}
                      {isExpanded && (
                        <div className="mt-3.5 overflow-hidden rounded-xl border border-border bg-muted/30">
                          <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3.5 py-2 text-xs font-medium text-muted-foreground">
                            <span>Assigned open leads</span>
                            {!leadsLoading && <span className="tabular-nums">{leads.length} total</span>}
                          </div>
                          {leadsLoading ? (
                            <div className="flex items-center gap-2 px-3.5 py-4 text-xs text-muted-foreground">
                              <Loader2 className="size-3.5 animate-spin" />
                              <span>Loading leads…</span>
                            </div>
                          ) : leads.length === 0 ? (
                            <p className="px-3.5 py-4 text-xs text-muted-foreground">No open leads assigned.</p>
                          ) : (
                            <ul className="max-h-72 divide-y divide-border overflow-y-auto">
                              {leads.map((l) => (
                                <li
                                  key={l.id}
                                  className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-sm transition-colors hover:bg-background/60"
                                >
                                  <div className="flex min-w-0 items-center gap-2.5">
                                    <Avatar size="sm">
                                      <AvatarFallback className="text-[10px] font-medium">
                                        {initialsOf(l.name || l.phone)}
                                      </AvatarFallback>
                                    </Avatar>
                                    <div className="min-w-0">
                                      <p className="truncate font-medium text-foreground">{l.name || l.phone}</p>
                                      {l.name && <p className="truncate text-xs text-muted-foreground tabular-nums">{l.phone}</p>}
                                    </div>
                                  </div>
                                  <ReassignSelect contactId={l.id} current={m.user_id} />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>

          {canEdit && (
            <CardFooter className="flex flex-wrap items-center justify-between gap-3 py-3">
              {others.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="flex size-7 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
                    <UserPlus className="size-3.5" />
                  </span>
                  <Select
                    value=""
                    disabled={busy === 'add'}
                    onValueChange={(val) => {
                      const id = val ? String(val) : '';
                      if (id) {
                        void run(
                          'add',
                          () => api('/api/callers', { method: 'POST', body: JSON.stringify({ userId: id }) }),
                          'Caller added'
                        );
                      }
                    }}
                  >
                    <SelectTrigger size="sm" className="min-w-56 bg-background">
                      <SelectValue placeholder="Add a team member as caller…" />
                    </SelectTrigger>
                    <SelectContent>
                      {others.map((m) => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {nameOf(m)} ({m.account_role})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">All current team members are already added.</span>
              )}

              <Link
                href="/settings?tab=members"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                <span>Invite team members in Settings</span>
                <ArrowUpRight className="size-3.5" />
              </Link>
            </CardFooter>
          )}
        </Card>

        {/* Admin Unassigned Queue */}
        <Card className={cn(unassigned.length > 0 && 'ring-amber-500/45')}>
          <CardHeader className="border-b">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'flex size-8 items-center justify-center rounded-lg',
                  unassigned.length > 0
                    ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400'
                    : 'bg-muted text-muted-foreground'
                )}
              >
                <Inbox className="size-4" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle>Admin Unassigned</CardTitle>
                  <Badge
                    variant={unassigned.length > 0 ? 'default' : 'secondary'}
                    className={cn(
                      'tabular-nums',
                      unassigned.length > 0 && 'bg-amber-500 text-white hover:bg-amber-500/90'
                    )}
                  >
                    {unassigned.length}
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  Leads awaiting assignment or moved from inactive callers.
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="p-0">
            {unassigned.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-5" />
                </span>
                <p className="mt-3 text-sm font-medium text-foreground">All caught up</p>
                <p className="mt-1 text-xs text-muted-foreground">Nothing waiting for an owner.</p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {unassigned.map((u) => {
                  const displayName = u.name || u.phone || 'Unknown';
                  return (
                    <li
                      key={u.contact_id}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm transition-colors hover:bg-muted/20"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <Avatar size="sm">
                          <AvatarFallback className="text-[10px] font-medium">
                            {initialsOf(displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium text-foreground">{displayName}</span>
                            {u.priority && (
                              <Badge className="h-4 bg-amber-500 px-1.5 text-[10px] font-semibold text-white">
                                Priority
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            {u.name && u.phone && <span className="tabular-nums">{u.phone}</span>}
                            {u.since && (
                              <span className="text-[11px]">
                                {u.name && u.phone ? '· ' : ''}
                                {formatDistanceToNow(new Date(u.since), { addSuffix: true })}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <ReassignSelect contactId={u.contact_id} current={null} />
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
