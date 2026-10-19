'use client';

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';

/** One fetch per page load, shared by every thread that asks. */
let cached: Promise<string> | null = null;

/**
 * The account's agent working language (language_settings, migration
 * 049); 'en' until loaded or when translation is switched off.
 */
export function useAgentLanguage(): string {
  const { hasFeature } = useAuth();
  const enabled = hasFeature('translation');
  const [lang, setLang] = useState('en');

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    cached ??= fetch('/api/language-settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => (d?.settings?.agent_language as string | undefined) ?? 'en')
      .catch(() => {
        cached = null; // allow a retry on the next mount
        return 'en';
      });
    cached.then((l) => alive && setLang(l));
    return () => {
      alive = false;
    };
  }, [enabled]);

  return lang;
}
