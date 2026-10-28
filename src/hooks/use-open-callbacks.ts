"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { getNotificationPermission, readBrowserNotifyPref } from "@/lib/notifications/browser-notify";

/**
 * Open (not Done) callback requests for the sidebar badge (migration 058).
 * RLS scopes reads to the user's account. Mounted once (sidebar), so it
 * also announces new requests: a toast, plus a desktop notification when
 * the device opted into browser notifications.
 */
export function useOpenCallbacks(): number {
  const [count, setCount] = useState(0);
  const t = useTranslations("Callbacks");
  // Latest translator for the long-lived realtime callback.
  const tRef = useRef(t);
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    tRef.current = t;
    routerRef.current = router;
  }, [t, router]);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const refresh = async () => {
      const { count: open, error } = await supabase
        .from("callback_requests")
        .select("id", { count: "exact", head: true })
        .neq("status", "done");
      if (!cancelled && !error) setCount(open ?? 0);
    };
    void refresh();

    const announce = async (contactId: string) => {
      const { data: c } = await supabase.from("contacts").select("name, phone").eq("id", contactId).maybeSingle();
      const who = [c?.name, c?.phone].filter(Boolean).join(" · ") || tRef.current("aContact");
      toast(tRef.current("toastTitle"), {
        description: who,
        action: { label: tRef.current("open"), onClick: () => routerRef.current.push("/callbacks") },
      });
      if (readBrowserNotifyPref() && getNotificationPermission() === "granted" && document.visibilityState !== "visible") {
        const n = new window.Notification(tRef.current("toastTitle"), { body: who, tag: `callback-${contactId}` });
        n.onclick = () => {
          window.focus();
          routerRef.current.push("/callbacks");
        };
      }
    };

    const channel = supabase
      .channel("callback-requests-open")
      .on("postgres_changes", { event: "*", schema: "public", table: "callback_requests" }, (payload) => {
        void refresh();
        if (payload.eventType === "INSERT") {
          const row = payload.new as { contact_id?: string };
          if (row.contact_id) void announce(row.contact_id);
        }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  return count;
}
