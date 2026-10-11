// Per-account smart-sending settings (delivery_settings, migration 048).
// Pure — safe to import from client components.

export interface DeliverySettings {
  auto_retry_limited: boolean;
  retry_delay_hours: number;
  rest_days: number;
  rest_after_unread: number;
  quality_guard: boolean;
  yellow_pass_size: number;
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  auto_retry_limited: true,
  retry_delay_hours: 24,
  rest_days: 7,
  rest_after_unread: 5,
  quality_guard: true,
  yellow_pass_size: 100,
};

const RANGES: Record<
  'retry_delay_hours' | 'rest_days' | 'rest_after_unread' | 'yellow_pass_size',
  [number, number]
> = {
  retry_delay_hours: [12, 72],
  rest_days: [1, 60],
  rest_after_unread: [2, 20],
  yellow_pass_size: [10, 1000],
};

export function parseDeliverySettings(
  body: unknown
): { ok: true; value: DeliverySettings } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const out = { ...DEFAULT_DELIVERY_SETTINGS };
  for (const key of ['auto_retry_limited', 'quality_guard'] as const) {
    if (b[key] !== undefined) {
      if (typeof b[key] !== 'boolean') return { ok: false, error: `${key} must be true or false` };
      out[key] = b[key] as boolean;
    }
  }
  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    if (b[key] === undefined) continue;
    const n = Number(b[key]);
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, error: `${key} must be a whole number between ${min} and ${max}` };
    }
    out[key] = n;
  }
  return { ok: true, value: out };
}
