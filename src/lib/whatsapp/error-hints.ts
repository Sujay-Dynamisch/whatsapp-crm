// ============================================================
// Meta send errors in plain words, with what to do about them.
// Used by the Failed messages page (migration 060). Pure.
// ============================================================

/** What usually fixes it. */
export type FailureFix =
  | 'retry_later' // temporary — resend later (or schedule)
  | 'send_text' // only a free-form message gets through (24h window open)
  | 'fix_template' // the template itself must be fixed / approved
  | 'check_number' // the number isn't on WhatsApp / can't receive
  | 'reconnect' // WhatsApp connection / account problem
  | 'unknown';

export interface FailureHint {
  reason: string;
  fix: FailureFix;
  /** Resending the same thing can work. */
  retryable: boolean;
}

const HINTS: Record<number, FailureHint> = {
  131049: {
    reason: 'Meta limited marketing messages to this person (too many recently). Try later, or send a normal message while their 24h window is open.',
    fix: 'retry_later',
    retryable: true,
  },
  131047: {
    reason: 'More than 24 hours since their last message — only an approved template can be sent.',
    fix: 'fix_template',
    retryable: false,
  },
  131026: {
    reason: 'Could not be delivered — the number may not be on WhatsApp, or uses an old app version.',
    fix: 'check_number',
    retryable: false,
  },
  131051: { reason: 'This message type is not supported.', fix: 'unknown', retryable: false },
  131056: { reason: 'Too many messages to this person in a short time.', fix: 'retry_later', retryable: true },
  130429: { reason: 'Sending too fast (rate limit).', fix: 'retry_later', retryable: true },
  131016: { reason: 'WhatsApp service was unavailable.', fix: 'retry_later', retryable: true },
  131000: { reason: 'Something went wrong at Meta.', fix: 'retry_later', retryable: true },
  131008: { reason: 'A required value was missing.', fix: 'fix_template', retryable: false },
  131009: { reason: 'A value in the message was not valid.', fix: 'fix_template', retryable: false },
  132000: { reason: 'The number of template variables does not match the template.', fix: 'fix_template', retryable: false },
  132001: { reason: 'The template does not exist or is not approved in this language.', fix: 'fix_template', retryable: false },
  132005: { reason: 'The template text is too long after filling in the variables.', fix: 'fix_template', retryable: false },
  132007: { reason: 'The template breaks WhatsApp’s content policy.', fix: 'fix_template', retryable: false },
  132012: { reason: 'A template variable has the wrong format.', fix: 'fix_template', retryable: false },
  132015: { reason: 'The template is paused by Meta (low quality).', fix: 'fix_template', retryable: false },
  132016: { reason: 'The template is disabled by Meta.', fix: 'fix_template', retryable: false },
  131031: { reason: 'The WhatsApp Business account is locked.', fix: 'reconnect', retryable: false },
  131042: { reason: 'A billing / payment problem on the WhatsApp Business account.', fix: 'reconnect', retryable: false },
  131045: { reason: 'The phone number is not registered with WhatsApp Business.', fix: 'reconnect', retryable: false },
  133010: { reason: 'The phone number is not registered with WhatsApp Business.', fix: 'reconnect', retryable: false },
  368: { reason: 'The account is temporarily blocked for policy violations.', fix: 'reconnect', retryable: false },
  190: { reason: 'The WhatsApp access token expired — reconnect WhatsApp in Settings.', fix: 'reconnect', retryable: false },
  100: { reason: 'Meta rejected a value in the request.', fix: 'fix_template', retryable: false },
};

/** Plain-words reason + fix for a Meta error code (or the raw text when unknown). */
export function explainFailure(code: number | null | undefined, title?: string | null): FailureHint {
  if (code !== null && code !== undefined && HINTS[code]) return HINTS[code];
  const t = String(title ?? '').toLowerCase();
  if (/24.?hour|re-?engagement|window/.test(t)) return HINTS[131047];
  if (/rate|too many|throughput/.test(t)) return HINTS[130429];
  if (/token|oauth|session has expired/.test(t)) return HINTS[190];
  if (/template/.test(t)) return { reason: String(title), fix: 'fix_template', retryable: false };
  return { reason: String(title ?? '') || 'Sending failed for an unknown reason.', fix: 'unknown', retryable: true };
}
