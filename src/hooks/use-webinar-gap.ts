"use client";

import { useEffect, useState } from "react";

import type { WebinarGap } from "@/lib/webinars/gap";

/**
 * "Add the next webinar session" state (src/lib/webinars/gap.ts) for the
 * header warning. Polls every 5 min while the tab is visible; null when
 * disabled or unavailable.
 */
export function useWebinarGap(enabled: boolean): WebinarGap | null {
  const [gap, setGap] = useState<WebinarGap | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await fetch("/api/webinars/gap").catch(() => null);
      if (!res?.ok || cancelled) return;
      setGap((await res.json().catch(() => null)) as WebinarGap | null);
    };
    void load();
    const t = window.setInterval(() => void load(), 5 * 60_000);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
  return enabled ? gap : null;
}
