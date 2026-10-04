// ============================================================
// Google Cloud access tokens without the googleapis SDK.
//
// Two sources, picked automatically:
//
//   1. GCP_SERVICE_ACCOUNT_KEY is set (raw JSON or base64 of it) —
//      sign a JWT and exchange it at the token endpoint. This is the
//      path for the Next.js app when it is hosted outside Google Cloud
//      (Vercel, a container elsewhere). Store the key in the host's
//      secret store; it never reaches the browser.
//
//   2. Otherwise — the GCE/Cloud Run metadata server. This is the path
//      inside the Cloud Functions, which run as their own service
//      account and need no key at all.
//
// Tokens are cached until a minute before expiry.
// ============================================================

import { createSign } from 'crypto';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

let cached: { token: string; expiresAt: number } | null = null;

function parseKey(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith('{')
    ? raw
    : Buffer.from(raw.trim(), 'base64').toString('utf8');
  const key = JSON.parse(text) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) {
    throw new Error('GCP_SERVICE_ACCOUNT_KEY is missing client_email/private_key');
  }
  return key;
}

const b64url = (input: string | Buffer) =>
  Buffer.from(input).toString('base64url');

async function tokenFromKey(
  key: ServiceAccountKey
): Promise<{ token: string; expiresIn: number }> {
  const tokenUri = key.token_uri || 'https://oauth2.googleapis.com/token';
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat,
      exp: iat + 3600,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(key.private_key));

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(
      `Google token exchange failed (${res.status}): ${body.error_description ?? 'no access_token'}`
    );
  }
  return { token: body.access_token, expiresIn: body.expires_in ?? 3600 };
}

async function tokenFromMetadata(): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' },
  });
  if (!res.ok) {
    throw new Error(
      `Metadata server token request failed (${res.status}). Outside Google Cloud, set GCP_SERVICE_ACCOUNT_KEY.`
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresIn: body.expires_in };
}

export async function getGcpAccessToken(
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const raw = env.GCP_SERVICE_ACCOUNT_KEY;
  const { token, expiresIn } = raw?.trim()
    ? await tokenFromKey(parseKey(raw))
    : await tokenFromMetadata();

  cached = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}
