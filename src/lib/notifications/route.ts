import type { Notification } from "@/types";

/** Where a notification opens — shared by the Notifications page and pop-ups. */
export function notificationHref(n: Pick<Notification, "type" | "conversation_id">): string | null {
  switch (n.type) {
    case "callback_requested":
    case "callback_overdue":
    case "callback_returned":
      return "/callbacks";
    case "health_alert":
    case "health_summary":
      return "/failed-messages";
    default:
      return n.conversation_id ? `/inbox?c=${n.conversation_id}` : null;
  }
}
