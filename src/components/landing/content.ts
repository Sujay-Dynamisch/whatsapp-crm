// Landing page copy and data. Everything claimed about WACRM here exists
// in this repository. Competitor cells come from public sources (vendor
// sites, help centres, third-party reviews) checked in November 2026;
// "unknown" means we could not find it publicly — not that it is missing.

export const COMPARE_CHECKED = 'November 2026';

export type Cell =
  | { v: 'yes'; note?: string }
  | { v: 'partial'; note: string }
  | { v: 'no'; note?: string }
  | { v: 'unknown' }
  | { v: 'text'; note: string };

export interface CompareRow {
  feature: string;
  detail?: string;
  wacrm: Cell;
  aisensy: Cell;
  wati: Cell;
}

const Y = (note?: string): Cell => ({ v: 'yes', ...(note ? { note } : {}) });
const P = (note: string): Cell => ({ v: 'partial', note });
const N = (note?: string): Cell => ({ v: 'no', ...(note ? { note } : {}) });
const U: Cell = { v: 'unknown' };
const T = (note: string): Cell => ({ v: 'text', note });

export const COMPARE: { group: string; rows: CompareRow[] }[] = [
  {
    group: 'Messaging',
    rows: [
      { feature: 'Official WhatsApp Business API', wacrm: Y(), aisensy: Y(), wati: Y() },
      { feature: 'Shared team inbox', wacrm: Y(), aisensy: Y(), wati: Y() },
      { feature: 'Template broadcasts & scheduling', wacrm: Y(), aisensy: Y(), wati: Y() },
      {
        feature: 'Smart sending',
        detail: 'Auto-retry of Meta-limited sends (131049), engagement scores, resting, quality guard',
        wacrm: Y(),
        aisensy: U,
        wati: U,
      },
      { feature: 'Inbox translation & voice-note transcription', wacrm: Y(), aisensy: U, wati: U },
    ],
  },
  {
    group: 'Automation',
    rows: [
      { feature: 'No-code chatbot flow builder', wacrm: Y(), aisensy: Y(), wati: Y() },
      {
        feature: 'Multi-step customer journeys',
        detail: 'Waits, “wait until”, branches, loops, HTTP & code steps, per-step conversion',
        wacrm: Y(),
        aisensy: P('Drip sequences on higher plans'),
        wati: P('Flow builder; complex multi-step flows reported harder'),
      },
      { feature: 'Webhook- & schedule-triggered journeys', wacrm: Y(), aisensy: U, wati: U },
      { feature: 'Lost-lead revival', detail: 'A closed-lost lead writes back → team alerted, menu re-sent', wacrm: Y(), aisensy: U, wati: U },
    ],
  },
  {
    group: 'Team & operations',
    rows: [
      { feature: 'Callback desk', detail: '“No answer” follow-ups, 4-hour reminders, back-to-nurture', wacrm: Y(), aisensy: U, wati: U },
      { feature: 'Failed-message recovery', detail: 'Resend, schedule, or send as text while the 24h window is open', wacrm: Y(), aisensy: U, wati: U },
      { feature: 'Health alerts & daily summary', detail: 'Scheduler and lead-feed monitoring', wacrm: Y(), aisensy: U, wati: U },
      {
        feature: 'Roles & permissions',
        wacrm: Y('Custom roles · None / View / Edit per area'),
        aisensy: U,
        wati: P('Fixed set of predefined roles'),
      },
    ],
  },
  {
    group: 'AI',
    rows: [
      { feature: 'AI replies & drafts', wacrm: Y('Bring your own OpenAI / Anthropic key'), aisensy: U, wati: Y('Astra AI agent') },
      { feature: 'AI knowledge base', wacrm: Y(), aisensy: U, wati: Y() },
    ],
  },
  {
    group: 'Platform',
    rows: [
      { feature: 'Public REST API & webhooks', wacrm: Y(), aisensy: Y(), wati: Y() },
      { feature: 'MCP server', detail: 'Drive your CRM from Claude, Cursor and other MCP clients', wacrm: Y(), aisensy: U, wati: U },
      { feature: 'Native e-commerce integrations', detail: 'Shopify and similar', wacrm: P('Via API & webhooks'), aisensy: Y(), wati: Y() },
      { feature: 'Click-to-WhatsApp ads tooling', wacrm: N(), aisensy: Y(), wati: U },
      { feature: 'Hosting', wacrm: T('Managed for you — or on your own servers'), aisensy: T('Hosted SaaS'), wati: T('Hosted SaaS') },
      { feature: 'Starting price', wacrm: T('₹999 / month'), aisensy: T('≈ ₹1,500 / month*'), wati: T('≈ $49 / month, billed yearly*') },
    ],
  },
];

export const COMPARE_SOURCES = [
  { label: 'WATI — roles and permissions', url: 'https://support.wati.io/en/articles/11463020-understanding-different-roles-and-permissions' },
  { label: 'WATI — Astra AI agent in chatbot flows', url: 'https://support.wati.io/en/articles/15186551-how-to-connect-your-astra-ai-agent-to-a-chatbot-flow-in-wati' },
  { label: 'WATI on Capterra', url: 'https://www.capterra.com/p/204314/WATI/' },
  { label: 'WATI review (Hackceleration)', url: 'https://hackceleration.com/labs/review/wati' },
  { label: 'AiSensy on Capterra', url: 'https://www.capterra.com/p/240134/AiSensy/' },
  { label: 'AiSensy alternatives (WANotifier)', url: 'https://wanotifier.com/best-aisensy-alternatives/' },
];

export const STATS = [
  { value: 15, suffix: '', label: 'Permission areas per role' },
  { value: 4, suffix: '', label: 'Interface languages' },
  { value: 60, suffix: 's', label: 'Scheduler heartbeat' },
  { value: 999, prefix: '₹', suffix: '', label: 'Starting price / month' },
];

export const FEATURES: { icon: string; title: string; body: string; tag?: string }[] = [
  { icon: 'Inbox', title: 'Shared inbox', body: 'Every WhatsApp chat in one place — assignment, presence, quick replies, reactions and media.' },
  { icon: 'Route', title: 'Journeys', body: 'Visual multi-step funnels with waits, branches, loops, HTTP and code steps. See conversion per step.', tag: 'Flagship' },
  { icon: 'Radio', title: 'Broadcasts', body: 'Template campaigns to segments, scheduled ahead, with delivery and reply tracking.' },
  { icon: 'Gauge', title: 'Smart sending', body: 'Retries Meta-limited sends automatically, rests over-messaged contacts and guards your quality rating.' },
  { icon: 'Bot', title: 'AI agents', body: 'Draft and auto-reply with your own OpenAI or Anthropic key, grounded in your knowledge base.' },
  { icon: 'Workflow', title: 'Flows & automations', body: 'Chatbot menus and trigger-based automations without code.' },
  { icon: 'PhoneCall', title: 'Callback desk', body: 'Leads who ask for a call land in a queue with reminders, “no answer” follow-ups and nurture hand-back.' },
  { icon: 'MessageSquareWarning', title: 'Failed-message recovery', body: 'See what Meta refused, why, and resend, schedule or send it as text in one click.', tag: 'New' },
  { icon: 'ShieldCheck', title: 'Custom roles', body: 'Build roles like “Sales agent” with None / View / Edit per area — enforced down to the database.', tag: 'New' },
  { icon: 'Languages', title: 'Multilingual inbox', body: 'Translate customer messages and agent replies; transcribe and summarise voice notes.' },
  { icon: 'GitBranch', title: 'Pipelines & deals', body: 'Move deals through stages without leaving the conversation.' },
  { icon: 'Webhook', title: 'API, webhooks & MCP', body: 'A public REST API, outbound webhooks and an MCP server to drive the CRM from AI tools.' },
];

// ------------------------------------------------------------------
// Pricing. Plans are sold monthly; WhatsApp (Meta) message charges are
// billed separately at Meta's rates. Edit prices here.
// ------------------------------------------------------------------
export const CONTACT = {
  name: 'Sujal Khedekar',
  phoneDisplay: '+91 93597 42537',
  phone: '919359742537',
  demoText: 'Hi Sujal, I would like a free live demo of the WhatsApp CRM.',
};
export const demoLink = (plan?: string) =>
  `https://wa.me/${CONTACT.phone}?text=${encodeURIComponent(plan ? `Hi Sujal, I'm interested in the ${plan} plan of the WhatsApp CRM. Can I get a free live demo?` : CONTACT.demoText)}`;

/**
 * UPI payments for plans. NEXT_PUBLIC_PAYMENT_UPI_ID overrides the UPI ID
 * (set at build time); empty hides the "Pay via UPI" buttons.
 */
export const PAYMENT = {
  upiId: (process.env.NEXT_PUBLIC_PAYMENT_UPI_ID ?? 'khedekarsujay5-1@okicici').trim(),
  /** Shown as the payee in UPI apps (the bank's verified name is shown too). */
  payee: 'wacrm',
};

/** "Choose plan": open WhatsApp with a purchase message. */
export const purchaseLink = (plan: Plan) =>
  `https://wa.me/${CONTACT.phone}?text=${encodeURIComponent(
    plan.amount
      ? `Hi Sujal, I want to subscribe to the ${plan.name} plan (${plan.price}/month) of the WhatsApp CRM. Please share the payment details.`
      : `Hi Sujal, I'm interested in the ${plan.name} plan of the WhatsApp CRM. Can we talk?`
  )}`;

/** UPI deep link with the plan amount filled in (opens WhatsApp Pay / GPay / PhonePe on phones). */
// Encoded the way UPI apps expect: "@" kept as is, spaces as %20 (some
// apps don't decode "%40" or "+").
const upiValue = (v: string) => encodeURIComponent(v).replace(/%40/g, '@');
export const upiLink = (plan: Plan) =>
  'upi://pay?' +
  [
    ['pa', PAYMENT.upiId],
    ['pn', PAYMENT.payee],
    ['am', (plan.amount ?? 0).toFixed(2)],
    ['cu', 'INR'],
    ['tn', `wacrm ${plan.name} plan - 1 month`],
  ]
    .map(([k, v]) => `${k}=${upiValue(v)}`)
    .join('&');

/** After paying: tell Sujal on WhatsApp. */
export const paidLink = (plan: Plan) =>
  `https://wa.me/${CONTACT.phone}?text=${encodeURIComponent(
    `Hi Sujal, I've paid ${plan.price} via UPI for the ${plan.name} plan (1 month) of the WhatsApp CRM. UPI reference: `
  )}`;

/** Approximate charge per marketing message (Meta's rate in India; changes with Meta pricing). */
export const MARKETING_MESSAGE_PRICE = '₹0.89';

export interface Plan {
  name: string;
  price: string;
  /** Monthly amount in ₹ for UPI payment (none = talk to us). */
  amount?: number;
  period: string;
  blurb: string;
  highlight?: boolean;
  badge?: string;
  includes?: string;
  features: string[];
  cta: string;
}

export const PLANS: Plan[] = [
  {
    name: 'Starter',
    price: '₹999',
    amount: 999,
    period: '/month',
    blurb: 'For small businesses getting off manual WhatsApp.',
    features: [
      'WhatsApp CRM with shared team inbox',
      'Customer contacts, tags & notes',
      'Automated messages & basic follow-ups',
      'Template broadcasts & scheduled campaigns',
      'Easy-to-use dashboard',
      'Up to 2 team members',
    ],
    cta: 'Start with Starter',
  },
  {
    name: 'Growth',
    price: '₹1,999',
    amount: 1999,
    period: '/month',
    blurb: 'For teams that want follow-ups to run themselves.',
    highlight: true,
    badge: 'Most popular',
    includes: 'Everything in Starter, plus',
    features: [
      'Visual journeys — reminders, nurture, payment nudges',
      'Chatbot flows & trigger automations',
      'Smart sending — automatic retry of Meta-limited messages',
      'Callback desk with reminders',
      'Failed-message recovery (resend / schedule / send as text)',
      'AI reply drafts (your OpenAI / Anthropic key)',
      'Pipelines & deals',
      'Up to 5 team members',
    ],
    cta: 'Choose Growth',
  },
  {
    name: 'Business',
    price: '₹3,999',
    amount: 3999,
    period: '/month',
    blurb: 'For growing teams that need control and integrations.',
    includes: 'Everything in Growth, plus',
    features: [
      'Custom roles — None / View / Edit per area',
      'Public API, webhooks & MCP server',
      'Website lead sync with health alerts & daily summary',
      'Inbox translation & voice-note transcription',
      'AI knowledge base & auto-replies',
      'Unlimited team members',
      'Priority onboarding & support',
    ],
    cta: 'Choose Business',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    blurb: 'Multiple numbers, your own servers, custom journeys.',
    includes: 'Everything in Business, plus',
    features: ['Multiple WhatsApp numbers / brands', 'Self-hosted on your infrastructure', 'Custom journeys built for you', 'Dedicated account manager'],
    cta: 'Talk to us',
  },
];

/** Price comparison. Competitor figures come from third-party reviews and vary by source — see the note. */
export const PRICE_COMPARE: { label: string; wacrm: string; aisensy: string; wati: string }[] = [
  { label: 'Entry plan', wacrm: '₹999 / month', aisensy: '≈ ₹1,500 / month (Basic)', wati: '≈ $49–59 / month (Growth)' },
  { label: 'Mid plan', wacrm: '₹1,999 / month', aisensy: '≈ ₹3,200 / month (Pro)', wati: '≈ $98–99 / month (Pro)' },
  { label: 'Upper plan', wacrm: '₹3,999 / month', aisensy: 'Custom (Enterprise)', wati: '≈ $182–299 / month (Business)' },
  { label: 'Extra team members', wacrm: 'Included (2 / 5 / unlimited)', aisensy: '≈ ₹750 / agent / month', wati: 'Limited per plan' },
  { label: 'Journeys, callbacks, failed-message recovery', wacrm: 'From Growth', aisensy: 'Not listed', wati: 'Not listed' },
  { label: 'WhatsApp message charges', wacrm: 'Meta rates, passed through', aisensy: 'Meta rates, billed separately', wati: 'Meta rates, billed separately' },
];

export const PRICE_SOURCES = [
  { label: 'AiSensy pricing (QuickReply.ai)', url: 'https://www.quickreply.ai/blog/aisensy-pricing-plans' },
  { label: 'AiSensy review 2026 (Drenslio)', url: 'https://drenslio.it.com/blog/aisensy-platform-review-2026/' },
  { label: 'WATI pricing 2026 (Setsmart)', url: 'https://setsmart.io/blog/wati-pricing' },
  { label: 'WATI review (Dupple)', url: 'https://dupple.com/reviews/wati' },
  { label: 'WATI alternatives (InstantDM)', url: 'https://instantdm.com/blog/best-wati-alternatives-whatsapp-automation-2026' },
];

export const INDUSTRIES = [
  { icon: 'Store', name: 'Retail shops', use: 'Offers, restock alerts, order updates' },
  { icon: 'Stethoscope', name: 'Clinics & hospitals', use: 'Appointment reminders, reports, follow-ups' },
  { icon: 'UtensilsCrossed', name: 'Restaurants', use: 'Reservations, menus, festive campaigns' },
  { icon: 'GraduationCap', name: 'Coaching institutes', use: 'Webinar funnels, batch reminders, fee nudges' },
  { icon: 'Wrench', name: 'Service businesses', use: 'Booking confirmations, callbacks, payment reminders' },
  { icon: 'ShoppingBag', name: 'Online stores', use: 'Abandoned-payment nudges, broadcasts, support' },
  { icon: 'Rocket', name: 'Agencies & startups', use: 'Lead nurture, team inbox, API & roles' },
];

export const PAINS = [
  'Sending WhatsApp messages to every customer by hand',
  'Hours lost on follow-ups, payment reminders and appointment updates',
  'Leads going cold because nobody replied in time',
];
