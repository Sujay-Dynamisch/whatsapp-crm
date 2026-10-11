'use client';

import { useState } from 'react';
import { Languages, Loader2, Mic } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { languageName } from '@/lib/language/languages';
import type { Message } from '@/types';

/**
 * Translation / transcript extras under a message bubble (migration 049):
 *   - customer text: the translation into the agents' language, or a
 *     "Translate" link for older messages
 *   - voice note: transcript (+ summary for long ones)
 *   - agent reply sent translated: what the agent actually typed
 */
export function MessageLanguage({ message, isAgent }: { message: Message; isAgent: boolean }) {
  const t = useTranslations('Inbox.language');
  const { hasFeature } = useAuth();
  const [translated, setTranslated] = useState<{ text: string | null; lang: string | null } | null>(
    null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translation = translated?.text ?? message.translated_text ?? null;
  const lang = translated?.lang ?? message.detected_language ?? null;
  const muted = isAgent ? 'text-primary-foreground/75' : 'text-muted-foreground';
  const rule = isAgent ? 'border-primary-foreground/25' : 'border-border';

  async function translateNow() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/messages/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message_id: message.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setTranslated({ text: data.translated_text ?? null, lang: data.detected_language ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Translation failed');
    } finally {
      setBusy(false);
    }
  }

  const blocks: React.ReactNode[] = [];

  // Voice note transcript
  if (message.content_type === 'audio' && hasFeature('voice_transcription')) {
    if (message.transcript) {
      blocks.push(
        <div key="transcript" className="space-y-1">
          <p className={cn('flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide', muted)}>
            <Mic className="h-3 w-3" />
            {t('transcript')}
          </p>
          {message.transcript_summary && (
            <p className="text-sm font-medium">{message.transcript_summary}</p>
          )}
          <p className={cn('whitespace-pre-wrap break-words text-sm', message.transcript_summary && 'opacity-80')}>
            {message.transcript}
          </p>
        </div>
      );
    } else if (message.transcript_status === 'failed' || message.transcript_status === 'skipped') {
      blocks.push(
        <p key="transcript-status" className={cn('text-[11px] italic', muted)}>
          {t(message.transcript_status === 'failed' ? 'transcriptFailed' : 'transcriptSkipped')}
        </p>
      );
    }
  }

  // Customer message translation
  if (!isAgent && hasFeature('translation')) {
    if (translation) {
      blocks.push(
        <div key="translation" className="space-y-0.5">
          <p className={cn('flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide', muted)}>
            <Languages className="h-3 w-3" />
            {lang ? t('translatedFrom', { language: languageName(lang) }) : t('translation')}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{translation}</p>
        </div>
      );
    } else if (
      !lang &&
      (message.content_text?.trim() || message.transcript?.trim()) &&
      (message.content_type === 'text' || message.content_type === 'audio')
    ) {
      blocks.push(
        <button
          key="translate"
          type="button"
          onClick={translateNow}
          disabled={busy}
          className={cn('inline-flex items-center gap-1 text-[11px] font-medium hover:underline', muted)}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Languages className="h-3 w-3" />}
          {t('translate')}
        </button>
      );
    }
    if (error) {
      blocks.push(
        <p key="error" className="text-[11px] text-destructive">
          {error}
        </p>
      );
    }
  }

  // Agent reply that went out translated
  if (isAgent && message.original_text) {
    blocks.push(
      <p key="original" className={cn('whitespace-pre-wrap break-words text-[11px] italic', muted)}>
        {t('youWrote', { text: message.original_text })}
      </p>
    );
  }

  if (blocks.length === 0) return null;
  return <div className={cn('mt-2 space-y-2 border-t pt-2', rule)}>{blocks}</div>;
}
