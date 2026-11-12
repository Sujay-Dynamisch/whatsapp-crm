// ============================================================
// In-app alert sound — exactly ONE sound per alert:
//   * a desktop (browser) notification was shown → the OS plays its own
//     notification sound, so we stay silent;
//   * no desktop notification (browser notifications off / not allowed,
//     or this alert didn't need one) → we play a short chime here.
//
// Generated with Web Audio (no asset). Browsers only allow audio after a
// user gesture, so unlockAlertSound() is wired to the first click/key.
// ============================================================

let ctx: AudioContext | null = null;
let lastAt = 0;

/** Min gap between chimes, so a burst of alerts doesn't machine-gun. */
const THROTTLE_MS = 1500;

/** Device-scoped mute for the in-app chime (default: on). */
export const ALERT_SOUND_STORAGE_KEY = 'wacrm:alert-sound';

export function readAlertSoundPref(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function writeAlertSoundPref(on: boolean): void {
  try {
    window.localStorage.setItem(ALERT_SOUND_STORAGE_KEY, on ? '1' : '0');
  } catch {
    // best effort
  }
}

function audio(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Call from a user gesture (first click / key press) so later chimes can play. */
export function unlockAlertSound(): void {
  const a = audio();
  if (a && a.state === 'suspended') void a.resume().catch(() => undefined);
}

/** Two-note "ding-dong". Silent when muted, throttled, or audio is still locked. */
export function playAlertSound(opts: { urgent?: boolean } = {}): void {
  if (!readAlertSoundPref()) return;
  const now = Date.now();
  if (now - lastAt < THROTTLE_MS) return;
  const a = audio();
  if (!a) return;
  if (a.state === 'suspended') void a.resume().catch(() => undefined);
  lastAt = now;

  const notes = opts.urgent ? [880, 660, 880] : [880, 660];
  const t0 = a.currentTime + 0.01;
  notes.forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = t0 + i * 0.16;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + 0.4);
  });
}
