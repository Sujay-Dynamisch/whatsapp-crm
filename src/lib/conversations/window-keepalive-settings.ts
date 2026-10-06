// ============================================================
// 24h-window keep-alive settings (migration 044). Pure — safe to
// import from client components.
// ============================================================

export interface KeepaliveSettings {
  enabled: boolean;
  lead_minutes: number;
  quiet_minutes: number;
  message_text: string;
}

export const DEFAULT_KEEPALIVE_SETTINGS: KeepaliveSettings = {
  enabled: false,
  lead_minutes: 60,
  quiet_minutes: 30,
  message_text:
    "Hi! Just checking in — is there anything else we can help you with? Reply here and we'll be happy to assist.",
};

/** Validates a settings patch; returns an error message or the clean value. */
export function parseKeepaliveSettings(
  body: unknown
): { ok: true; value: KeepaliveSettings } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const enabled = b.enabled === true;
  const lead = Number(b.lead_minutes ?? DEFAULT_KEEPALIVE_SETTINGS.lead_minutes);
  const quiet = Number(b.quiet_minutes ?? DEFAULT_KEEPALIVE_SETTINGS.quiet_minutes);
  const text =
    typeof b.message_text === 'string' ? b.message_text.trim() : DEFAULT_KEEPALIVE_SETTINGS.message_text;

  if (!Number.isInteger(lead) || lead < 15 || lead > 240) {
    return { ok: false, error: 'lead_minutes must be a whole number between 15 and 240' };
  }
  if (!Number.isInteger(quiet) || quiet < 0 || quiet > 240) {
    return { ok: false, error: 'quiet_minutes must be a whole number between 0 and 240' };
  }
  if (text.length < 1 || text.length > 1000) {
    return { ok: false, error: 'message_text must be 1–1000 characters' };
  }
  return { ok: true, value: { enabled, lead_minutes: lead, quiet_minutes: quiet, message_text: text } };
}
