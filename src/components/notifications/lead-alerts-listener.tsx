"use client";

// Headless. A lost / closed lead wrote back (notification 'lead_returned',
// migration 061): pop it up top-right for the people it was sent to, with
// a button to open the chat. Mounted once in the dashboard shell.

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { getNotificationPermission, readBrowserNotifyPref } from "@/lib/notifications/browser-notify";
import { playAlertSound } from "@/lib/notifications/sound";

export function LeadAlertsListener() {
  const { user } = useAuth();
  const t = useTranslations("Callbacks");
  const router = useRouter();
  const tRef = useRef(t);
  const routerRef = useRef(router);
  useEffect(() => {
    tRef.current = t;
    routerRef.current = router;
  }, [t, router]);

  useEffect(() => {
    if (!user) return;
    const supabase = createClient();
    const channel = supabase
      .channel("lead-returned-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const n = payload.new as { type?: string; title?: string; body?: string | null; conversation_id?: string | null };
        if (n.type !== "lead_returned") return;
        const open = () => routerRef.current.push(n.conversation_id ? `/inbox?c=${n.conversation_id}` : "/notifications");
        toast(`💬 ${n.title ?? ""}`, {
          description: n.body ?? undefined,
          duration: 20_000,
          action: { label: tRef.current("openChat"), onClick: open },
        });
        // One sound per alert: desktop notification (OS sound) or the in-app chime.
        let desktopShown = false;
        if (readBrowserNotifyPref() && getNotificationPermission() === "granted" && document.visibilityState !== "visible") {
          try {
            const d = new window.Notification(n.title ?? "", { body: n.body ?? undefined, tag: `lead-returned-${n.conversation_id ?? ""}` });
            d.onclick = () => {
              window.focus();
              open();
            };
            desktopShown = true;
          } catch {
            // needs a service worker on some browsers
          }
        }
        if (!desktopShown) playAlertSound({ urgent: true });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  return null;
}
