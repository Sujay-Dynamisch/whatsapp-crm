// Languages offered for the agents' working language and shown on
// translated messages. ISO 639-1 codes. Pure — client-safe.
// Indian languages first: most WhatsApp customers write in them.

export interface LanguageInfo {
  code: string;
  name: string;
  native: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'or', name: 'Odia', native: 'ଓଡ଼ିଆ' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'zh', name: 'Chinese', native: '中文' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

/** Normalise "hi-IN", "HI", " hi " → "hi"; null for anything unusable. */
export function normalizeLanguage(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  const base = code.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function languageName(code: string | null | undefined): string {
  if (!code) return '';
  return BY_CODE.get(code)?.name ?? code.toUpperCase();
}

export function isSupportedLanguage(code: unknown): code is string {
  return typeof code === 'string' && BY_CODE.has(code);
}
