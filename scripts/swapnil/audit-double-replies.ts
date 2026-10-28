// Read-only: finds customer messages in Swapnil's account (last N days)
// that got BOTH a journey reply and a non-journey bot reply (AI / flow).
//   npx jiti scripts/swapnil/audit-double-replies.ts [days]
import { ACCOUNT_ID, connect } from './common';

async function main() {
  const days = Number(process.argv[2] ?? 7);
  const db = await connect();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const { data: convs } = await db.from('conversations').select('id, contact_id, contacts(name, phone)').eq('account_id', ACCOUNT_ID).gte('last_message_at', since).limit(500);
  const { data: jm } = await db.from('journey_messages').select('whatsapp_message_id').eq('account_id', ACCOUNT_ID).gte('created_at', since).limit(10000);
  const journeyWamids = new Set((jm ?? []).map((m) => m.whatsapp_message_id).filter(Boolean));
  let doubles = 0;
  for (const c of convs ?? []) {
    const { data: msgs } = await db.from('messages').select('*').eq('conversation_id', c.id).gte('created_at', since).order('created_at').limit(1000);
    const list = msgs ?? [];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender_type !== 'customer') continue;
      const replies: { src: string; text: string }[] = [];
      for (let k = i + 1; k < list.length && list[k].sender_type !== 'customer'; k++) {
        const r = list[k];
        if (r.sender_type !== 'bot') continue;
        const src = journeyWamids.has(r.message_id) ? 'JOURNEY' : r.ai_generated ? 'AI' : 'flow/other';
        replies.push({ src, text: String(r.content_text ?? r.template_name ?? '').slice(0, 70) });
      }
      const kinds = new Set(replies.map((r) => r.src));
      if (kinds.size > 1) {
        doubles++;
        const ct = (Array.isArray(c.contacts) ? c.contacts[0] : c.contacts) as { name?: string; phone?: string } | null;
        console.log(`\n${m.created_at} ${ct?.name ?? ''} ${ct?.phone ?? ''}\n  customer: ${String(m.content_text ?? '').slice(0, 70)}`);
        for (const r of replies) console.log(`  ${r.src.padEnd(8)} ${r.text.replace(/\n/g, ' ')}`);
      }
    }
  }
  console.log(`\n${doubles} customer message(s) answered by both a journey and the AI/flow in the last ${days} day(s).`);
}
main().catch((e) => { console.error(e); process.exit(1); });
