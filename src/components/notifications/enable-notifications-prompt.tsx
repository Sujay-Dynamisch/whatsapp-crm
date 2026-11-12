"use client";

// Asks the user to turn on browser notifications (so callbacks and chats
// alert them with the computer's sound even when this tab is in the
// background). Hidden once they're on, when the browser can't do them,
// or for 3 days after "Later".

import { useState, useSyncExternalStore } from "react";
import { BellRing, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  getNotificationPermission,
  readBrowserNotifyPref,
  subscribeBrowserNotifyPref,
  writeBrowserNotifyPref,
} from "@/lib/notifications/browser-notify";
import { unlockAlertSound } from "@/lib/notifications/sound";

const DISMISS_KEY = "wacrm:notify-prompt-dismissed-at";
const SNOOZE_MS = 3 * 24 * 3600_000;

function snoozed(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY));
    return Number.isFinite(at) && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

/** "on" | "off" | "denied" | "unsupported" — a string so useSyncExternalStore compares cheaply. */
function snapshot(): string {
  const p = getNotificationPermission();
  if (p === "unsupported") return "unsupported";
  if (p === "denied") return "denied";
  return p === "granted" && readBrowserNotifyPref() ? "on" : "off";
}

export function EnableNotificationsPrompt() {
  const state = useSyncExternalStore(subscribeBrowserNotifyPref, snapshot, () => "unsupported");
  const [hidden, setHidden] = useState(() => typeof window === "undefined" || snoozed());
  const [busy, setBusy] = useState(false);

  if (hidden || state === "on" || state === "unsupported") return null;

  const later = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    setHidden(true);
  };

  const enable = async () => {
    unlockAlertSound();
    if (getNotificationPermission() === "granted") {
      writeBrowserNotifyPref(true);
      toast.success("Browser notifications are on");
      return;
    }
    setBusy(true);
    try {
      const result = await Notification.requestPermission();
      writeBrowserNotifyPref(result === "granted");
      if (result === "granted") toast.success("Browser notifications are on");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <BellRing className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Turn on browser notifications</p>
        <p className="text-xs text-muted-foreground">
          {state === "denied"
            ? "Notifications are blocked for this site. Click the 🔒 icon in the address bar → Notifications → Allow, then reload."
            : "Get callback requests and new chats with a sound, even when this tab is in the background."}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {state !== "denied" && (
          <Button size="sm" disabled={busy} onClick={() => void enable()}>
            Turn on
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={later} aria-label="Remind me later">
          {state === "denied" ? <X className="size-4" /> : "Later"}
        </Button>
      </div>
    </div>
  );
}
