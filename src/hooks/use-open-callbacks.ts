"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/**
 * Open (not Done) callback requests for the sidebar badge (migration 058).
 * RLS scopes reads to the user's account. New requests, 4-hour reminders
 * and "back in nurture" notices pop up through useNotificationPopups
 * (they are notifications rows), so this only keeps the count live.
 * Idle (0, no realtime) while the account's "callbacks" feature is off.
 */
export function useOpenCallbacks(enabled = true, opts: { priorityOnly?: boolean } = {}): number {
  const priorityOnly = !!opts.priorityOnly;
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const supabase = createClient();
    let cancelled = false;

    const refresh = async () => {
      let q = supabase
        .from("callback_requests")
        .select("id", { count: "exact", head: true })
        .neq("status", "done");
      // Caller management (086): customer-requested (Priority) only.
      if (priorityOnly) q = q.eq("priority", "high");
      const { count: open, error } = await q;
      if (!cancelled && !error) setCount(open ?? 0);
    };
    void refresh();

    const channel = supabase
      .channel(priorityOnly ? "callback-requests-priority" : "callback-requests-open")
      .on("postgres_changes", { event: "*", schema: "public", table: "callback_requests" }, () => {
        void refresh();
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [enabled, priorityOnly]);

  return enabled ? count : 0;
}
