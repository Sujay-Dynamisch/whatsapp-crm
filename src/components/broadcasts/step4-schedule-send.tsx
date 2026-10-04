'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DEFAULT_BROADCAST_TIMEZONE,
  utcToZonedLocal,
  zonedLocalToUtc,
} from '@/lib/broadcast-scheduling/time';

/** Offered in the picker; the browser's own zone is added when missing. */
const COMMON_TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Jakarta',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Madrid',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'UTC',
];

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  /** Present when server-side scheduling is offered. */
  onSchedule?: (localDatetime: string, timezone: string) => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
  processedCount?: number;
  totalCount?: number;
  sentCount?: number;
  failedCount?: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSchedule,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
  processedCount = 0,
  totalCount = 0,
  sentCount = 0,
  failedCount = 0,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  const [mode, setMode] = useState<'now' | 'schedule'>('now');
  const [timezone, setTimezone] = useState(DEFAULT_BROADCAST_TIMEZONE);
  const [localDatetime, setLocalDatetime] = useState(() =>
    utcToZonedLocal(new Date(Date.now() + 60 * 60 * 1000), DEFAULT_BROADCAST_TIMEZONE),
  );

  const ownZone = browserTimeZone();
  const timezoneOptions =
    ownZone && !COMMON_TIMEZONES.includes(ownZone)
      ? [...COMMON_TIMEZONES, ownZone]
      : COMMON_TIMEZONES;

  const isScheduling = mode === 'schedule' && Boolean(onSchedule);
  let scheduledInstant: Date | null = null;
  if (isScheduling) {
    try {
      scheduledInstant = zonedLocalToUtc(localDatetime, timezone);
    } catch {
      scheduledInstant = null;
    }
  }
  // Evaluated at render; the server re-validates with a small tolerance.
  const nowMs = Date.now();
  const scheduleInPast =
    isScheduling && (!scheduledInstant || scheduledInstant.getTime() < nowMs);
  const scheduledLabel = `${localDatetime.replace('T', ' ')} (${timezone})`;

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Send now vs. schedule */}
      {onSchedule && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === 'now' ? 'default' : 'outline'}
              onClick={() => setMode('now')}
              disabled={isProcessing}
            >
              <Send className="h-3.5 w-3.5" />
              {t('scheduleSend.modeNow')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'schedule' ? 'default' : 'outline'}
              onClick={() => setMode('schedule')}
              disabled={isProcessing}
            >
              <CalendarClock className="h-3.5 w-3.5" />
              {t('scheduleSend.modeSchedule')}
            </Button>
          </div>

          {mode === 'schedule' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">
                  {t('scheduleSend.scheduleAt')}
                </label>
                <Input
                  type="datetime-local"
                  value={localDatetime}
                  onChange={(e) => setLocalDatetime(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs text-muted-foreground">
                  {t('scheduleSend.timezone')}
                </label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground"
                >
                  {timezoneOptions.map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
              <p
                className={`text-xs sm:col-span-2 ${
                  scheduleInPast ? 'text-destructive' : 'text-muted-foreground'
                }`}
              >
                {scheduleInPast
                  ? t('scheduleSend.schedulePastError')
                  : t('scheduleSend.scheduleHint')}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Processing overlay with live numbers */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <Loader2 className="h-5 w-5 animate-spin text-primary shrink-0" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {progress < 30 ? t('scheduleSend.preparing') : t('scheduleSend.sending')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {totalCount > 0
                    ? `${processedCount} of ${totalCount} contacts processed (${sentCount} sent, ${failedCount} failed)`
                    : `${progress}% completed`}
                </p>
              </div>
            </div>
            <span className="text-sm font-bold text-primary">{progress}%</span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          {totalCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-primary/10 pt-2.5 text-xs">
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                ✓ {sentCount} Successful
              </span>
              {failedCount > 0 && (
                <span className="font-medium text-destructive">
                  ✕ {failedCount} Failed
                </span>
              )}
              <span className="text-muted-foreground">
                Total: {totalCount} contacts
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || scheduleInPast}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {isScheduling ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {isScheduling ? t('scheduleSend.scheduleBtn') : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {isScheduling
                  ? t('scheduleSend.confirmScheduleTitle')
                  : t('scheduleSend.confirmTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {isScheduling
                  ? t.rich('scheduleSend.confirmScheduleDesc', {
                      count: estimatedReach,
                      template: template.name,
                      when: scheduledLabel,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })
                  : t.rich('scheduleSend.confirmDesc', {
                      count: estimatedReach,
                      template: template.name,
                      b: (chunks) => (
                        <span className="font-medium text-popover-foreground">{chunks}</span>
                      ),
                    })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  if (isScheduling && onSchedule) onSchedule(localDatetime, timezone);
                  else onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {isScheduling ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {isScheduling ? t('scheduleSend.scheduleBtn') : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
