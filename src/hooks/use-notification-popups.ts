"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import { getNotificationPermission } from "@/lib/notifications/browser-notify";
import { notificationHref } from "@/lib/notifications/route";
import { useBrowserNotifyPref } from "@/hooks/use-browser-notifications";
import type { Notification } from "@/types";

/** Alerts the team must act on now stay on screen longer. */
const URGENT = new Set<Notification["type"]>([
  "callback_requested",
  "callback_overdue",
  "payment_click",
  "message_failed",
  "window_closing",
  "health_alert",
]);
const EMOJI: Partial<Record<Notification["type"], string>> = {
  callback_requested: "📞",
  callback_overdue: "⏰",
  payment_click: "💳",
  message_failed: "⚠️",
  window_closing: "⌛",
  health_alert: "🚨",
  lead_returned: "💬",
  conversation_assigned: "👤",
};

/**
 * Pops up every new notification for the signed-in user the moment it is
 * created: an on-screen alert with an "Open" action, plus a desktop
 * notification when the tab is in the background and browser
 * notifications are on. RLS limits the stream to the user's own rows.
 * Mount once per dashboard tab (BrowserNotificationsListener).
 */
export function useNotificationPopups(): void {
  const router = useRouter();
  const t = useTranslations("Notifications");
  const desktopEnabled = useBrowserNotifyPref();
  const ref = useRef({ router, t, desktopEnabled });
  useEffect(() => {
    ref.current = { router, t, desktopEnabled };
  });

  useEffect(() => {
    const supabase = createClient();
    const seen = new Set<string>();
    const channel = supabase
      .channel("notification-popups")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
        const n = payload.new as Notification;
        if (seen.has(n.id)) return;
        seen.add(n.id);
        const { router: r, t: tr, desktopEnabled: desktop } = ref.current;
        const href = notificationHref(n);
        const title = `${EMOJI[n.type] ?? "🔔"} ${n.title}`;
        const open = () => {
          if (href) r.push(href);
          void supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id).is("read_at", null);
        };

        toast(title, {
          id: `notification-${n.id}`,
          description: n.body ?? undefined,
          duration: URGENT.has(n.type) ? 20_000 : 8_000,
          action: href ? { label: tr("open"), onClick: open } : undefined,
        });

        if (desktop && getNotificationPermission() === "granted" && document.visibilityState !== "visible") {
          try {
            const d = new window.Notification(title, { body: n.body ?? "", tag: `notification-${n.id}`, icon: "/icon" });
            d.onclick = () => {
              window.focus();
              open();
              d.close();
            };
          } catch {
            // Some browsers (e.g. Android Chrome) need a service worker.
          }
        }
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);
}
