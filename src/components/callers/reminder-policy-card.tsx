'use client';

// Callback reminders + AI callback detection settings (migration 087),
// in plain language: dropdowns and time pickers instead of raw numbers.

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, Clock, Loader2, PhoneCall, Sparkles, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

interface Settings {
  priority_initial_min: number;
  priority_repeat_min: number;
  priority_max_reminders: number;
  standard_initial_min: number;
  standard_repeat_min: number;
  standard_max_reminders: number;
  window_start_hour: number;
  window_end_hour: number;
  window_days: number[];
  timezone: string;
  escalate_to: 'admins' | 'none';
  repeat_until_handled: boolean;
  ai_detection_enabled: boolean;
  ai_confidence_threshold: number;
}

interface Option {
  value: string;
  label: string;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function durationLabel(min: number): string {
  if (min < 60) return `${min} minutes`;
  if (min % 1440 === 0) return min === 1440 ? '1 day' : `${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? '1 hour' : `${min / 60} hours`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Preset durations, plus the saved value if it isn't one of them. */
function durationOptions(presets: number[], current: number): Option[] {
  const all = [...new Set([...presets, current])].sort((a, b) => a - b);
  return all.map((m) => ({ value: String(m), label: durationLabel(m) }));
}

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return '12:00 AM (midnight)';
  if (h === 12) return '12:00 PM (noon)';
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

const FIRST_PRESETS = [5, 10, 15, 30, 60, 120, 240, 480, 1440];
const REPEAT_PRESETS = [15, 30, 60, 120, 240, 480, 1440];
const COUNT_OPTIONS: Option[] = [
  { value: '0', label: 'Never remind' },
  ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: i === 0 ? '1 time' : `${i + 1} times` })),
];
const SENSITIVITY: Option[] = [
  { value: '0.9', label: 'Strict — only very clear requests' },
  { value: '0.75', label: 'Balanced (recommended)' },
  { value: '0.6', label: 'Relaxed — catch more, review more' },
];

function Pick({
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const label = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Select value={value} onValueChange={(v) => v != null && onChange(String(v))} disabled={disabled}>
      <SelectTrigger className={cn('h-9 w-full min-w-0 bg-background', className)}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

function ScheduleBlock({
  icon,
  title,
  hint,
  tone,
  first,
  repeat,
  max,
  onFirst,
  onRepeat,
  onMax,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  tone: 'amber' | 'primary';
  first: number;
  repeat: number;
  max: number;
  onFirst: (n: number) => void;
  onRepeat: (n: number) => void;
  onMax: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4">
      <div className="mb-3 flex items-start gap-2.5">
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            tone === 'amber' ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400' : 'bg-primary/10 text-primary'
          )}
        >
          {icon}
        </span>
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="First reminder">
          <Pick value={String(first)} options={durationOptions(FIRST_PRESETS, first)} onChange={(v) => onFirst(Number(v))} disabled={disabled} />
        </Field>
        <Field label="Then remind every">
          <Pick value={String(repeat)} options={durationOptions(REPEAT_PRESETS, repeat)} onChange={(v) => onRepeat(Number(v))} disabled={disabled} />
        </Field>
        <Field label="Remind at most">
          <Pick value={String(max)} options={COUNT_OPTIONS} onChange={(v) => onMax(Number(v))} disabled={disabled} />
        </Field>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {max === 0
          ? 'No reminders will be sent.'
          : `First reminder ${durationLabel(first)} after it comes in${max > 1 ? `, then every ${durationLabel(repeat)}` : ''} — up to ${max === 1 ? 'once' : `${max} times`}.`}
      </p>
    </div>
  );
}

function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-border px-4 py-3 transition-colors hover:bg-muted/40">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

export function ReminderPolicyCard({ canEdit }: { canEdit: boolean }) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/callers/settings')
      .then((r) => r.json())
      .then((d: { settings?: Settings }) => {
        if (!alive || !d.settings) return;
        const next = { ...d.settings, ai_confidence_threshold: Number(d.settings.ai_confidence_threshold) };
        setS(next);
        setSaved(JSON.stringify(next));
      })
      .catch(() => toast.error('Could not load reminder settings'));
    return () => {
      alive = false;
    };
  }, []);

  const dirty = useMemo(() => !!s && JSON.stringify(s) !== saved, [s, saved]);
  const startHours = useMemo(() => Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) })), []);
  const endHours = useMemo(() => Array.from({ length: 24 }, (_, i) => ({ value: String(i + 1), label: hourLabel(i + 1) })), []);

  if (!s) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const ro = !canEdit || saving;
  const sensitivity = SENSITIVITY.some((o) => Number(o.value) === s.ai_confidence_threshold)
    ? String(s.ai_confidence_threshold)
    : '0.75';

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/callers/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save');
      const next = { ...d.settings, ai_confidence_threshold: Number(d.settings.ai_confidence_threshold) };
      setS(next);
      setSaved(JSON.stringify(next));
      toast.success('Reminder settings saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BellRing className="size-4" />
          </span>
          <div>
            <CardTitle>Callback reminders</CardTitle>
            <CardDescription className="text-xs">
              We nudge the caller who owns the lead (or owners and admins if nobody does) until the callback is marked Called or Done.
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-5 pt-5">
        <div className="grid gap-4 xl:grid-cols-2">
          <ScheduleBlock
            icon={<PhoneCall className="size-4" />}
            tone="amber"
            title="When a customer asks for a call"
            hint="Priority requests — button taps and typed messages."
            first={s.priority_initial_min}
            repeat={s.priority_repeat_min}
            max={s.priority_max_reminders}
            onFirst={(n) => set('priority_initial_min', n)}
            onRepeat={(n) => set('priority_repeat_min', n)}
            onMax={(n) => set('priority_max_reminders', n)}
            disabled={ro}
          />
          <ScheduleBlock
            icon={<UserPlus className="size-4" />}
            tone="primary"
            title="When a new lead registers"
            hint="The regular follow-up call for every new lead."
            first={s.standard_initial_min}
            repeat={s.standard_repeat_min}
            max={s.standard_max_reminders}
            onFirst={(n) => set('standard_initial_min', n)}
            onRepeat={(n) => set('standard_repeat_min', n)}
            onMax={(n) => set('standard_max_reminders', n)}
            disabled={ro}
          />
        </div>

        <div className="rounded-xl border border-border p-4">
          <div className="mb-3 flex items-start gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-sky-500/12 text-sky-600 dark:text-sky-400">
              <Clock className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-foreground">Reminder hours</p>
              <p className="text-xs text-muted-foreground">
                Reminders are only sent during these hours (India time). Anything due outside them waits until the next working time.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,180px)_minmax(0,180px)_1fr] sm:items-end">
            <Field label="Start sending at">
              <Pick value={String(s.window_start_hour)} options={startHours} onChange={(v) => set('window_start_hour', Number(v))} disabled={ro} />
            </Field>
            <Field label="Stop sending at">
              <Pick value={String(s.window_end_hour)} options={endHours} onChange={(v) => set('window_end_hour', Number(v))} disabled={ro} />
            </Field>
            <Field label="On these days">
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const on = s.window_days.includes(i + 1);
                  return (
                    <button
                      key={d}
                      type="button"
                      aria-pressed={on}
                      disabled={ro}
                      onClick={() => set('window_days', on ? s.window_days.filter((x) => x !== i + 1) : [...s.window_days, i + 1].sort())}
                      className={cn(
                        'h-9 min-w-11 rounded-lg border px-2.5 text-xs font-medium transition-colors disabled:opacity-60',
                        on ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'border-border bg-background text-muted-foreground hover:bg-muted'
                      )}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
          </div>
          {s.window_end_hour <= s.window_start_hour && (
            <p className="mt-2 text-xs text-destructive">The stop time must be later than the start time.</p>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <ToggleRow
            title="Tell owners & admins if it's still not handled"
            hint="After the last reminder, owners and admins get an alert too."
            checked={s.escalate_to === 'admins'}
            onChange={(v) => set('escalate_to', v ? 'admins' : 'none')}
            disabled={ro}
          />
          <ToggleRow
            title="Keep reminding until someone calls"
            hint="Don't stop after the last reminder — keep nudging at the same pace."
            checked={s.repeat_until_handled}
            onChange={(v) => set('repeat_until_handled', v)}
            disabled={ro}
          />
        </div>

        <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-2.5">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/12 text-violet-600 dark:text-violet-400">
                <Sparkles className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Spot call requests in chat messages</p>
                <p className="text-xs text-muted-foreground">
                  When a customer types something like “Please call me, typing is difficult” or “mujhe call karo”, it becomes a priority callback — no button needed.
                </p>
              </div>
            </div>
            <Switch checked={s.ai_detection_enabled} disabled={ro} onCheckedChange={(v) => set('ai_detection_enabled', v)} />
          </div>
          {s.ai_detection_enabled && (
            <div className="mt-3 max-w-sm pl-10">
              <Field label="How sure should it be?">
                <Pick value={sensitivity} options={SENSITIVITY} onChange={(v) => set('ai_confidence_threshold', Number(v))} disabled={ro} />
              </Field>
              <p className="mt-1.5 text-xs text-muted-foreground">Messages it isn&apos;t sure about show up as “Needs review” instead.</p>
            </div>
          )}
        </div>
      </CardContent>

      {canEdit && (
        <CardFooter className="justify-between gap-3 border-t">
          <p className="text-xs text-muted-foreground">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</p>
          <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || s.window_end_hour <= s.window_start_hour}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Save changes
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
