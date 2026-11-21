'use client';

// Webinar Schedule (migration 097): plan the live sessions the webinar
// journey books leads into — skip days, alternate days, cancel or move a
// session (booked leads are moved to the next one and told).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CalendarClock, CalendarPlus, Check, Copy, Loader2, Pencil, RotateCcw, Settings2, Users, X } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';

interface Session {
  id: string;
  starts_at: string;
  start_iso: string;
  link: string | null;
  status: 'scheduled' | 'cancelled';
  note: string | null;
  upcoming: boolean;
  booked: number;
}
interface Rules {
  weekday_cutoff_min: number;
  weekday_msg2_min: number;
  weekday_msg3_min: number;
  weekend_cutoff_min: number;
  weekend_msg2_min: number;
  weekend_msg3_min: number;
  checkin_hour: number;
  default_weekday_time: string;
  default_weekend_time: string;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const istDate = (iso: string) => iso.slice(0, 10);
const istTime = (iso: string) => iso.slice(11, 16);
function fmtDate(isoDate: string) {
  const d = new Date(`${isoDate}T12:00:00+05:30`);
  return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}
function fmtTime(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function todayIst(): string {
  return new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
}
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const dow = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || 'Something went wrong');
  return body as T;
}

const SELECT = 'h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export default function WebinarsPage() {
  const { can } = useAuth();
  const canEdit = can('webinars', 'edit');
  const [data, setData] = useState<{ sessions: Session[]; rules: Rules; upcoming: number; low: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Add sessions
  const [pattern, setPattern] = useState<'daily' | 'alternate' | 'weekdays'>('daily');
  const [from, setFrom] = useState(todayIst());
  const [span, setSpan] = useState(14);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [customTime, setCustomTime] = useState('');
  const [link, setLink] = useState('');

  // Edit a session
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState({ date: '', time: '', link: '' });
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<Rules | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<{ sessions: Session[]; rules: Rules; upcoming: number; low: boolean }>('/api/webinars');
      setData(d);
      setRules(d.rules);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the schedule');
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const planned = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < span; i++) {
      const d = addDays(from, i);
      if (pattern === 'alternate' && i % 2 === 1) continue;
      if (pattern === 'weekdays' && !days.includes(dow(d))) continue;
      out.push(d);
    }
    return out;
  }, [from, span, pattern, days]);

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

  const addSessions = () =>
    run('add', async () => {
      const r = await api<{ added: number; skipped: number }>('/api/webinars', {
        method: 'POST',
        body: JSON.stringify({ dates: planned, time: customTime || undefined, link: link || undefined }),
      });
      toast.success(`Added ${r.added} session${r.added === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} already scheduled` : ''}`);
    });

  const cancel = async (s: Session) => {
    const ok = await confirmDialog({
      title: `Cancel ${fmtDate(istDate(s.start_iso))}, ${fmtTime(istTime(s.start_iso))}?`,
      description:
        s.booked > 0
          ? `${s.booked} registered lead${s.booked === 1 ? '' : 's'} will be moved to the next scheduled session and get a WhatsApp message with the new date, time and link.`
          : 'Nobody is booked into this session yet.',
      confirmLabel: 'Cancel session',
      destructive: true,
    });
    if (!ok) return;
    await run(`c-${s.id}`, async () => {
      const r = await api<{ moved: number }>(`/api/webinars/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
      toast.success(r.moved ? `Session cancelled — ${r.moved} lead${r.moved === 1 ? '' : 's'} moved to the next session` : 'Session cancelled');
    });
  };

  const saveEdit = async (s: Session) => {
    const timeChanged = edit.date !== istDate(s.start_iso) || edit.time !== istTime(s.start_iso);
    if (timeChanged && s.booked > 0) {
      const ok = await confirmDialog({
        title: 'Change the session time?',
        description: `${s.booked} booked lead${s.booked === 1 ? '' : 's'} will get a WhatsApp message with the new date and time, and their reminders will be re-timed.`,
        confirmLabel: 'Change time',
      });
      if (!ok) return;
    }
    await run(`e-${s.id}`, async () => {
      const r = await api<{ moved: number }>(`/api/webinars/${s.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ date: edit.date, time: edit.time, link: edit.link }),
      });
      setEditing(null);
      toast.success(r.moved ? `Saved — ${r.moved} lead${r.moved === 1 ? '' : 's'} told about the change` : 'Saved');
    });
  };

  const saveRules = () =>
    rules &&
    run('rules', () => api('/api/webinars/settings', { method: 'PATCH', body: JSON.stringify(rules) }), 'Timing rules saved');

  if (!data || !rules) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const upcoming = data.sessions.filter((s) => s.upcoming);
  const byDate = upcoming.reduce<Record<string, Session[]>>((acc, s) => {
    (acc[istDate(s.start_iso)] ??= []).push(s);
    return acc;
  }, {});
  const hrs = (min: number) => (min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${min % 60} min`);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            <CalendarClock className="size-6 text-primary" /> Webinar Schedule
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            New registrations are booked into the next session below. Cancel or move one and the booked leads are moved and told automatically.
          </p>
        </div>
        {canEdit && (
          <Button variant="outline" size="sm" onClick={() => setShowRules((v) => !v)}>
            <Settings2 className="size-3.5" /> Timing rules
          </Button>
        )}
      </div>

      {data.low && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            Only {data.upcoming} upcoming session{data.upcoming === 1 ? '' : 's'} scheduled. Add more — when none is scheduled, the journey falls back to a session every day ({fmtTime(rules.default_weekday_time)} weekdays, {fmtTime(rules.default_weekend_time)} weekends).
          </span>
        </div>
      )}

      {showRules && canEdit && (
        <Card>
          <CardHeader className="border-b">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>Timing rules</CardTitle>
                <CardDescription className="text-xs">How long before each session the journey stops booking it and sends the reminders (India time).</CardDescription>
              </div>
              <Button size="icon" variant="ghost" className="size-8 shrink-0" aria-label="Close timing rules" onClick={() => setShowRules(false)}>
                <X className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4 pt-4 md:grid-cols-2">
            {(['weekday', 'weekend'] as const).map((k) => (
              <div key={k} className="space-y-2.5 rounded-xl border border-border bg-muted/30 p-4">
                <p className="text-sm font-semibold capitalize text-foreground">{k} sessions</p>
                <label className="block space-y-1">
                  <span className="block text-xs text-muted-foreground">Default time</span>
                  <Input type="time" className="h-9" value={rules[`default_${k}_time`]} onChange={(e) => setRules({ ...rules, [`default_${k}_time`]: e.target.value })} />
                </label>
                {([
                  ['cutoff', 'Stop booking this session (registrations after go to the next one)'],
                  ['msg2', 'Reminder 1 (Msg 2)'],
                  ['msg3', 'Reminder 2 — "starting soon" (Msg 3)'],
                ] as const).map(([f, label]) => {
                  const key = `${k}_${f}_min` as keyof Rules;
                  return (
                    <label key={f} className="block space-y-1">
                      <span className="block text-xs text-muted-foreground">{label}</span>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          step={0.5}
                          className="h-9 w-24 tabular-nums"
                          value={Number(rules[key]) / 60}
                          onChange={(e) => setRules({ ...rules, [key]: Math.round(Number(e.target.value) * 60) })}
                        />
                        <span className="block text-xs text-muted-foreground">hours before ({hrs(Number(rules[key]))})</span>
                      </div>
                    </label>
                  );
                })}
              </div>
            ))}
            <label className="block space-y-1.5 md:col-span-2">
              <span className="block text-xs text-muted-foreground">Check-in message the next morning at</span>
              <select className={cn(SELECT, 'max-w-40')} value={rules.checkin_hour} onChange={(e) => setRules({ ...rules, checkin_hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {fmtTime(`${String(h).padStart(2, '0')}:00`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex justify-end md:col-span-2">
              <Button size="sm" disabled={busy === 'rules'} onClick={() => void saveRules()}>
                {busy === 'rules' && <Loader2 className="size-3.5 animate-spin" />} Save rules
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <CalendarPlus className="size-4 text-primary" /> Add sessions
            </CardTitle>
            <CardDescription className="text-xs">Plan several days at once. Days that already have a session are skipped.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pt-4">
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
              {([
                ['daily', 'Every day'],
                ['alternate', 'Alternate days'],
                ['weekdays', 'Chosen days'],
              ] as const).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setPattern(v)}
                  className={cn('rounded-lg px-3 py-2 text-sm font-medium', pattern === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}
                >
                  {label}
                </button>
              ))}
            </div>
            {pattern === 'weekdays' && (
              <div className="flex flex-wrap gap-1.5">
                {DAY_NAMES.map((d, i) => {
                  const on = days.includes(i);
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDays(on ? days.filter((x) => x !== i) : [...days, i])}
                      className={cn('h-9 min-w-11 rounded-lg border px-2.5 text-xs font-medium', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-muted')}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block space-y-1">
                <span className="block text-xs text-muted-foreground">Starting from</span>
                <Input type="date" className="h-9" value={from} min={todayIst()} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="block text-xs text-muted-foreground">For the next</span>
                <select className={SELECT} value={span} onChange={(e) => setSpan(Number(e.target.value))}>
                  {[7, 14, 21, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className="block text-xs text-muted-foreground">Time (blank = default)</span>
                <Input type="time" className="h-9" value={customTime} onChange={(e) => setCustomTime(e.target.value)} />
              </label>
              <label className="block space-y-1">
                <span className="block text-xs text-muted-foreground">Zoom link (blank = main link)</span>
                <Input className="h-9" placeholder="https://zoom.us/j/…" value={link} onChange={(e) => setLink(e.target.value)} />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {planned.length} session{planned.length === 1 ? '' : 's'}:{' '}
                {planned.slice(0, 6).map(fmtDate).join(', ')}
                {planned.length > 6 ? ` … +${planned.length - 6}` : ''}
                {!customTime && ` · ${fmtTime(rules.default_weekday_time)} weekdays, ${fmtTime(rules.default_weekend_time)} weekends`}
              </p>
              <Button size="sm" disabled={busy === 'add' || !planned.length} onClick={() => void addSessions()}>
                {busy === 'add' ? <Loader2 className="size-3.5 animate-spin" /> : <CalendarPlus className="size-3.5" />} Add {planned.length} session{planned.length === 1 ? '' : 's'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="border-b">
          <CardTitle>Upcoming sessions</CardTitle>
          <CardDescription className="text-xs">India time. “Booked” = registered leads waiting for that session.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {upcoming.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground">No upcoming sessions — add some above.</p>
          ) : (
            <ul className="divide-y divide-border">
              {Object.entries(byDate).map(([date, list]) =>
                list.map((s) => {
                  const cancelled = s.status === 'cancelled';
                  return (
                    <li key={s.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-3', cancelled && 'opacity-60')}>
                      <div className="w-28 shrink-0">
                        <p className="text-sm font-semibold text-foreground">{fmtDate(date)}</p>
                        <p className="text-xs tabular-nums text-muted-foreground">{fmtTime(istTime(s.start_iso))}</p>
                      </div>
                      {editing === s.id ? (
                        <div className="flex flex-1 flex-wrap items-center gap-2">
                          <Input type="date" className="h-8 w-36" value={edit.date} min={todayIst()} onChange={(e) => setEdit({ ...edit, date: e.target.value })} />
                          <Input type="time" className="h-8 w-28" value={edit.time} onChange={(e) => setEdit({ ...edit, time: e.target.value })} />
                          <Input className="h-8 min-w-48 flex-1" placeholder="Zoom link (blank = main link)" value={edit.link} onChange={(e) => setEdit({ ...edit, link: e.target.value })} />
                          <Button size="sm" disabled={busy === `e-${s.id}`} onClick={() => void saveEdit(s)}>
                            <Check className="size-3.5" /> Save
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                            <X className="size-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                            {cancelled ? (
                              <span className="rounded-full border border-rose-500/40 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400">Cancelled</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                                <Users className="size-3" /> {s.booked} booked
                              </span>
                            )}
                            {s.link ? (
                              <button
                                type="button"
                                onClick={() => void navigator.clipboard.writeText(s.link!).then(() => toast.success('Link copied'))}
                                className="inline-flex max-w-full items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3 shrink-0" />
                                <span className="truncate">{s.link}</span>
                              </button>
                            ) : (
                              <span className="block text-xs text-muted-foreground">Main webinar link</span>
                            )}
                          </div>
                          {canEdit && (
                            <div className="flex shrink-0 gap-1">
                              {!cancelled && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setEditing(s.id);
                                      setEdit({ date: istDate(s.start_iso), time: istTime(s.start_iso), link: s.link ?? '' });
                                    }}
                                  >
                                    <Pencil className="size-3.5" /> Edit
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy === `c-${s.id}`} onClick={() => void cancel(s)}>
                                    {busy === `c-${s.id}` ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />} Cancel
                                  </Button>
                                </>
                              )}
                              {cancelled && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy === `r-${s.id}`}
                                  onClick={() => void run(`r-${s.id}`, () => api(`/api/webinars/${s.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'scheduled' }) }), 'Session restored')}
                                >
                                  <RotateCcw className="size-3.5" /> Restore
                                </Button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </li>
                  );
                })
              )}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
