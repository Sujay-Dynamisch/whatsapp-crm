// Shared setup for the Swapnil Gautam one-off scripts (run with `npx jiti`).
// Loads .env.local, builds a service-role client, and refuses to run
// unless ACCOUNT_ID really is Swapnil Gautam's account.
import fs from 'node:fs';
import path from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const ACCOUNT_ID = 'ba23ef90-3416-44c9-84dd-b3b859d4d021';
export const OWNER_USER_ID = '24e37bfb-eb33-41e6-abe4-25774329ca04';
const OWNER_NAME = 'Swapnil Gautam';

export function loadEnv(): void {
  const envPath = path.resolve(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

export async function connect(): Promise<SupabaseClient> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, account_id')
    .eq('user_id', OWNER_USER_ID)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.account_id !== ACCOUNT_ID || data.full_name !== OWNER_NAME) {
    throw new Error(`Guard failed: ${OWNER_USER_ID} is not ${OWNER_NAME} in account ${ACCOUNT_ID}. Aborting.`);
  }
  return db;
}
