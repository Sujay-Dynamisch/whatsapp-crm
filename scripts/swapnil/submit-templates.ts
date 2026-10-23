// Creates the 5 pending webinar templates (T5–T9 from SG_WhatsApp_Templates.pdf)
// in Swapnil Gautam's account and submits them to Meta for approval.
//
//   npx jiti scripts/swapnil/submit-templates.ts            # dry run: validate + print
//   npx jiti scripts/swapnil/submit-templates.ts --submit   # submit to Meta + save rows
//
// Mirrors src/app/api/whatsapp/templates/submit/route.ts. Templates that
// already exist in the account (same name + language) are skipped.
import { ACCOUNT_ID, OWNER_USER_ID, connect } from './common';
import { validateTemplatePayload, type TemplatePayload } from '../../src/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '../../src/lib/whatsapp/template-components';
import { normalizeStatus } from '../../src/lib/whatsapp/template-status-normalize';

const STOP = 'Reply STOP to opt out.';
const qr = (...texts: string[]) => texts.map((text) => ({ type: 'QUICK_REPLY' as const, text }));

const TEMPLATES: TemplatePayload[] = [
  // T1–T4 as specified in the PDF (header + buttons). The account's older
  // registration_confirmation / reminder_for_webinar / trigger_sent_at_7 /
  // triggered_when_lead_selects_option_3 lack them; use-pdf-templates.ts
  // switches the journey over once these are approved.
  {
    name: 'sg_webinar_confirmation',
    category: 'Utility',
    language: 'en_US',
    header_type: 'text',
    header_content: "You're In! Webinar Details Inside",
    body_text: [
      'Hi {{1}},',
      '🎉 You’re in!',
      'Welcome to the Transformation Webinar with Swapnil Gautam.',
      '📅 Date: {{2}}\n🕒 Time: {{3}}\n🔗 Join Here: {{4}}',
      'This could be the first step towards a healthier, fitter you.',
      'See you inside!',
      '— Swapnil Gautam',
    ].join('\n\n'),
    sample_values: { body: ['Priya', 'Fri, 23 Oct 2026', '8:00 PM IST', 'https://example.com/webinar'] },
  },
  {
    name: 'sg_webinar_reminder',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Your Webinar with Swapnil Gautam is Soon!',
    body_text: [
      'Hi {{1}},',
      '⏳ Your Transformation Webinar is {{2}}.',
      'The people who transform are the ones who show up.',
      '📅 {{3}}\n🕒 {{4}}\n🔗 {{5}}',
      'See you inside!',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    sample_values: { body: ['Priya', 'coming up tonight at 8:00 PM', 'Fri, 23 Oct 2026', '8:00 PM IST', 'https://example.com/webinar'] },
  },
  {
    name: 'sg_post_webinar_checkin',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Quick Check-In from Swapnil Gautam',
    body_text: [
      'Hi {{1}},',
      'Your transformation doesn’t end with the webinar—it starts with your next step.',
      'Reply with:',
      '1️⃣ Join Revibe today (Get the payment link)\n2️⃣ See real success stories\n3️⃣ Missed the webinar? Get the next session\n4️⃣ Request a callback from my team',
      'Just reply with 1, 2, 3, or 4.',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    buttons: qr('Ready to Join', 'Want to see testimonials', 'Couldn’t attend', 'Request a callback'),
    sample_values: { body: ['Priya'] },
  },
  {
    name: 'sg_webinar_reinvite',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Here’s Your Next Webinar Date',
    body_text: [
      'Hi {{1}},',
      '🎉 You’re all set for the next Transformation Webinar with Swapnil Gautam.',
      '📅 Date: {{2}}\n🕒 Time: {{3}}\n🔗 Join Here: {{4}}',
      'This could be the session that changes your health. Don’t miss it!',
      'See you there.',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    sample_values: { body: ['Priya', 'Sat, 24 Oct 2026', '3:00 PM IST', 'https://example.com/webinar'] },
  },
  {
    name: 'sg_testimonial_reprompt',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Ready to Take the Next Step?',
    body_text: [
      'Hi {{1}},',
      'You’ve seen what’s possible through our members’ transformations.',
      'Now it’s your turn.',
      'Reply with:\n1️⃣ Join Revibe today (Get the payment link)\n2️⃣ Talk to my team (Request a callback)',
      'Your transformation starts with one decision.',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    buttons: qr('Ready to Join', 'Request Callback'),
    sample_values: { body: ['Priya'] },
  },
  {
    name: 'sg_nurture_prewebinar',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'We Missed You — Come Back',
    body_text: [
      'Hi {{1}},',
      'Your next opportunity for your transformation is here! Join the next Transformation Webinar and make the most of it!',
      '📅 Date: {{2}}\n🕒 Time: {{3}}\n🔗 Webinar link: {{4}}',
      'Your spot is waiting!',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    sample_values: { body: ['Priya', 'Sat, 25 Oct 2026', '3:00 PM IST', 'https://example.com/webinar'] },
  },
  {
    name: 'sg_nurture_postwebinar',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: "Still Thinking? Let's Talk",
    body_text: [
      'Hi {{1}},',
      'Whether you made it to the session or missed it, I wanted to personally follow up.',
      'The Transformation Webinar covers a lot in a short time. Most people say they needed a day or two to think before deciding their next step.',
      "That's completely okay. But I don't want you to lose momentum.",
      "What's on your mind? A short reply helps me point you in the right direction.",
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    buttons: qr("I'm Ready to Join", 'I Have Some Questions'),
    sample_values: { body: ['Priya'] },
  },
  {
    name: 'sg_nurture_coldlead',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Still Thinking It Over?',
    body_text: [
      'Hi {{1}},',
      "It's Swapnil here.",
      "You reached out after the webinar — and I don't want to leave you hanging.",
      "Here's what I hear most from people who paused:\n" +
        '• "Is this really for me?" — If you attended, something resonated. Let\'s explore that.\n' +
        '• "I don\'t have time" — Built for busy people.\n' +
        '• "Not sure about the investment" — Let\'s talk.',
      'Which one fits? Just reply — no sales pitch.',
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    buttons: qr("I'm Ready to Join", 'I Have Some Questions'),
    sample_values: { body: ['Priya'] },
  },
  {
    name: 'sg_nurture_payment',
    category: 'Marketing',
    language: 'en_US',
    header_type: 'text',
    header_content: 'Your Registration Is Incomplete',
    body_text: [
      'Hi {{1}},',
      'Your registration for the programme is still incomplete.',
      '🔗 Payment link: {{2}}',
      'I want to make sure nothing is standing in the way. A few things people ask at this stage:\n' +
        '— Can I pay in instalments?\n— What exactly is included?\n— When does the programme begin?',
      "Just reply and I'll sort it personally — 2 minutes.",
      '— Swapnil Gautam',
      STOP,
    ].join('\n\n'),
    buttons: qr('Complete Payment', 'I Have a Question', 'Not Proceeding'),
    sample_values: { body: ['Priya', 'https://example.com/pay'] },
  },
];

async function main() {
  const submit = process.argv.includes('--submit');
  const db = await connect();

  for (const p of TEMPLATES) validateTemplatePayload(p);
  console.log(`All ${TEMPLATES.length} templates pass validation.`);

  const { data: existing } = await db
    .from('message_templates')
    .select('name, language, status')
    .eq('account_id', ACCOUNT_ID);
  const have = new Set((existing ?? []).map((r) => `${r.name}|${r.language}`));

  if (!submit) {
    for (const p of TEMPLATES) {
      const skip = have.has(`${p.name}|${p.language}`) ? ' (exists — would skip)' : '';
      console.log(`\n--- ${p.name}${skip}\n${JSON.stringify(buildMetaTemplatePayload(p), null, 2)}`);
    }
    console.log('\nDry run only. Re-run with --submit to send to Meta.');
    return;
  }

  const { data: config } = await db.from('whatsapp_config').select('*').eq('account_id', ACCOUNT_ID).single();
  if (!config?.waba_id) throw new Error('WhatsApp is not connected (no waba_id) for this account.');
  const { decrypt } = await import('../../src/lib/whatsapp/encryption');
  const { submitMessageTemplate } = await import('../../src/lib/whatsapp/meta-api');
  const accessToken = decrypt(config.access_token);

  for (const p of TEMPLATES) {
    if (have.has(`${p.name}|${p.language}`)) {
      console.log(`skip  ${p.name} (already in account)`);
      continue;
    }
    let status = 'DRAFT';
    let metaTemplateId: string | null = null;
    let submissionError: string | null = null;
    try {
      const meta = await submitMessageTemplate({ wabaId: config.waba_id, accessToken, payload: buildMetaTemplatePayload(p) });
      status = normalizeStatus(meta.status);
      metaTemplateId = meta.id;
    } catch (e) {
      submissionError = e instanceof Error ? e.message : String(e);
    }
    const { error } = await db.from('message_templates').upsert(
      {
        account_id: ACCOUNT_ID,
        user_id: OWNER_USER_ID,
        name: p.name,
        category: p.category,
        language: p.language,
        template_type: 'standard',
        header_type: p.header_type ?? null,
        header_content: p.header_content ?? null,
        body_text: p.body_text,
        buttons: p.buttons ?? null,
        sample_values: p.sample_values ?? null,
        status,
        meta_template_id: metaTemplateId,
        submission_error: submissionError,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,name,language' }
    );
    console.log(
      `${submissionError ? 'FAIL' : 'ok  '}  ${p.name} → ${status}` +
        (submissionError ? ` — ${submissionError}` : '') +
        (error ? ` (local save failed: ${error.message})` : '')
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
