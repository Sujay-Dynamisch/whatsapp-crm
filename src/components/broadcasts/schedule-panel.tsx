'use client';

import { useState } from 'react';
import { CalendarClock, Loader2, RotateCcw, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Broadcast } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DEFAULT_BROADCAST_TIMEZONE,
  isValidTimeZone,
  utcToZonedLocal,
} from '@/lib/broadcast-scheduling/time';

interface SchedulePanelProps {
  broadcast: Broadcast;
  pendingCount: number;
  failedCount: number;
  onChanged: () => void | Promise<void>;
}

/**
 * Scheduled-send status and controls for one broadcast (migration 043).
 * Rendered by the detail page for any broadcast that has, or can have,
 * a server-side schedule.
 */
export function SchedulePanel({
  broadcast,
  pendingCount,
  failedCount,
  onChanged,
}: SchedulePanelProps) {
  const t = useTranslations('Broadcasts.detail.schedule');
  const timezone =
    broadcast.timezone && isValidTimeZone(broadcast.timezone)
      ? broadcast.timezone
      : DEFAULT_BROADCAST_TIMEZONE;

  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'cancel' | 'retry' | null>(null);
  const [tz, setTz] = useState(timezone);
  const [localDatetime, setLocalDatetime] = useState(() =>
    broadcast.scheduled_at
      ? utcToZonedLocal(new Date(broadcast.scheduled_at), timezone)
      : utcToZonedLocal(new Date(Date.now() + 60 * 60 * 1000), timezone),
  );

  const state = broadcast.schedule_status ?? null;
  const when = broadcast.scheduled_at
    ? `${utcToZonedLocal(new Date(broadcast.scheduled_at), timezone).replace('T', ' ')}`
    : null;

  const canReschedule =
    pendingCount > 0 &&
    (state === null ||
      state === 'scheduled' ||
      state === 'queued' ||
      state === 'failed' ||
      state === 'cancelled');
  const canCancel = state === 'scheduled' || state === 'queued' || state === 'failed';
  const canRetry =
    (state === 'failed' || state === 'completed') && pendingCount + failedCount > 0;

  async function call(
    kind: 'save' | 'cancel' | 'retry',
    url: string,
    init: RequestInit,
    success: (data: Record<string, unknown>) => string,
  ) {
    setBusy(kind);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(t('toastFailed', { error: data?.error || `HTTP ${res.status}` }));
        return;
      }
      toast.success(success(data));
      setEditing(false);
      await onChanged();
    } catch (err) {
      toast.error(
        t('toastFailed', { error: err instanceof Error ? err.message : 'Unknown error' }),
      );
    } finally {
      setBusy(null);
    }
  }

  const base = `/api/whatsapp/broadcast/${broadcast.id}/schedule`;
  const json = { 'Content-Type': 'application/json' };

  const stateLine = (() => {
    switch (state) {
      case 'scheduled':
        return t('stateScheduled');
      case 'queued':
        return t('stateQueued');
      case 'processing':
        return t('stateProcessing');
      case 'completed':
        return t('stateCompleted');
      case 'failed':
        return t('stateFailed', { error: broadcast.last_error ?? '—' });
      case 'cancelled':
        return t('stateCancelled');
      default:
        return t('stateUnscheduled');
    }
  })();

  const result = broadcast.execution_result;

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 text-sm">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="font-medium text-foreground">
              {when ? t('sendsAt', { when, timezone }) : t('title')}
            </p>
            <p
              className={`mt-0.5 ${
                state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
              }`}
            >
              {stateLine}
            </p>
            {result && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('result', {
                  sent: result.sent,
                  failed: result.failed,
                  pending: result.pending,
                })}
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canReschedule && !editing && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy !== null}>
              <CalendarClock className="h-3.5 w-3.5" />
              {state === null ? t('schedule') : t('reschedule')}
            </Button>
          )}
          {canCancel && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              onClick={() =>
                call('cancel', base, { method: 'DELETE' }, () => t('toastCancelled'))
              }
            >
              {busy === 'cancel' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {t('cancelSchedule')}
            </Button>
          )}
          {canRetry && (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                call(
                  'retry',
                  `${base}/retry`,
                  { method: 'POST', headers: json, body: JSON.stringify({ scope: 'all' }) },
                  (d) => t('toastRetried', { count: Number(d.recipients ?? 0) }),
                )
              }
            >
              {busy === 'retry' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              {t('retry')}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <div className="flex flex-wrap items-end gap-2 border-t border-border pt-3">
          <Input
            type="datetime-local"
            value={localDatetime}
            onChange={(e) => setLocalDatetime(e.target.value)}
            className="w-auto border-border bg-muted text-foreground"
          />
          <Input
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder={DEFAULT_BROADCAST_TIMEZONE}
            className="w-48 border-border bg-muted text-foreground"
          />
          <Button
            size="sm"
            disabled={busy !== null || !isValidTimeZone(tz)}
            onClick={() =>
              call(
                'save',
                base,
                {
                  method: 'POST',
                  headers: json,
                  body: JSON.stringify({ local_datetime: localDatetime, timezone: tz }),
                },
                () => t('toastRescheduled', { when: `${localDatetime.replace('T', ' ')} (${tz})` }),
              )
            }
          >
            {busy === 'save' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('save')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy !== null}>
            {t('close')}
          </Button>
        </div>
      )}
    </div>
  );
}
