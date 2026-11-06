"use client";

import { useBrowserNotifications } from "@/hooks/use-browser-notifications";
import { useNotificationPopups } from "@/hooks/use-notification-popups";

/**
 * Headless. Mount ONCE per signed-in dashboard tab (the dashboard
 * shell, below the auth gate) so alerts fire on every dashboard page:
 * new customer messages, and a pop-up for every new notification
 * (callbacks, payment taps, failed messages, closing chat windows…).
 */
export function BrowserNotificationsListener() {
  useBrowserNotifications();
  useNotificationPopups();
  return null;
}
