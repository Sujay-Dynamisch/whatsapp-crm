// Dry run of the registration sync for Swapnil's account: shows what
// the last hour of registrations would do. Writes nothing.
//   npx jiti scripts/swapnil/lead-sync-dry-run.ts
import { ACCOUNT_ID, connect } from './common';
import { toInternationalPhone } from '../../src/lib/lead-sync/registrations';

const URL_ = 'https://admin.swapnilgautam.com/api/auth';

async function main() {
  const db = await connect();
  const res = await fetch(`${URL_}?page=1&limit=50`);
  const { data } = (await res.json()) as { data: { fullName: string; whatsappNumber: string; city: string; createdAt: string }[] };
  const since = Date.now() - 60 * 60_000;
  const recent = data.filter((r) => Date.parse(r.createdAt) >= since);
  console.log(`last hour: ${recent.length} registration(s)`);
  for (const r of recent) {
    const phone = toInternationalPhone(r.whatsappNumber);
    const { data: hit } = phone
      ? await db.from('contacts').select('id').eq('account_id', ACCOUNT_ID).eq('phone', phone).maybeSingle()
      : { data: null };
    console.log(`  ${r.createdAt}  ${r.fullName} | ${phone ?? `INVALID ${r.whatsappNumber}`} | ${r.city} → ${!phone ? 'skip' : hit ? 'exists' : 'would create + start journey'}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
