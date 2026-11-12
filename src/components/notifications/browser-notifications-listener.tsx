"use client";

import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { useNotificationPopups } from "@/hooks/use-notification-popups";
import { useEffect } from "react";
import { unlockAlertSound } from "@/lib/notifications/sound";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so alerts fire on every dashboard page:
 * new customer messages, and a pop-up for every new notification
 * (callbacks, payment taps, failed messages, closing chat windows…).
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  useNotificationPopups();
  // Browsers block sound until the user interacts with the page once.
  useEffect(() => {
    const unlock = () => unlockAlertSound();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);
  return null;
}
