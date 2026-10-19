// ============================================================
// Voice-note transcription (migration 049) via Whisper on OpenAI or
// Groq (free tier). Both expose the same multipart
// /audio/transcriptions endpoint.
// ============================================================

export type TranscriptionProvider = 'openai' | 'groq';

export const TRANSCRIPTION_ENDPOINTS: Record<TranscriptionProvider, { url: string; model: string }> = {
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions', model: 'whisper-1' },
  groq: { url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3' },
};

/** Whisper rejects files over 25 MB. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function extensionFor(mime: string): string {
  const m = mime.split(';')[0].trim().toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg'; // WhatsApp voice notes are OGG/Opus
}

export async function transcribeAudio(args: {
  provider: TranscriptionProvider;
  apiKey: string;
  audio: Buffer;
  mimeType: string;
  timeoutMs?: number;
}): Promise<string> {
  if (args.audio.byteLength > MAX_AUDIO_BYTES) {
    throw new Error('Voice note is larger than the 25 MB transcription limit');
  }
  const { url, model } = TRANSCRIPTION_ENDPOINTS[args.provider];
  const form = new FormData();
  const type = args.mimeType.split(';')[0].trim() || 'audio/ogg';
  form.append(
    'file',
    new Blob([new Uint8Array(args.audio)], { type }),
    `voice.${extensionFor(args.mimeType)}`
  );
  form.append('model', model);
  form.append('response_format', 'json');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${args.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(args.timeoutMs ?? 60_000),
  });
  const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
  if (!res.ok) {
    throw new Error(
      `${args.provider} transcription failed (${res.status}): ${body.error?.message ?? 'unknown error'}`
    );
  }
  return (body.text ?? '').trim();
}
