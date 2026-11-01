// The public landing page (signed-out visitors at "/").

import Link from 'next/link';
import type { ComponentType } from 'react';
import {
  ArrowRight,
  Bot,
  Check,
  Gauge,
  GitBranch,
  GraduationCap,
  Inbox,
  Languages,
  MessageCircle,
  MessageSquareWarning,
  PhoneCall,
  Radio,
  Rocket,
  Route,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Stethoscope,
  Store,
  UtensilsCrossed,
  Webhook,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';

import { Globe } from './globe';
import { CompareTable } from './compare-table';
import { InboxDemo, JourneyDemo, RecoveryDemo, RolesDemo } from './demos';
import { Counter, Reveal, SpotlightGrid } from './reveal';
import {
  CONTACT,
  FEATURES,
  INDUSTRIES,
  MARKETING_MESSAGE_PRICE,
  PAINS,
  PLANS,
  PRICE_COMPARE,
  PRICE_SOURCES,
  STATS,
  demoLink,
} from './content';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Inbox, Route, Radio, Gauge, Bot, Workflow, PhoneCall, MessageSquareWarning, ShieldCheck, Languages, GitBranch, Webhook,
  Store, Stethoscope, UtensilsCrossed, GraduationCap, Wrench, ShoppingBag, Rocket,
};

const NAV = [
  { href: '#features', label: 'Features' },
  { href: '#compare', label: 'Compare' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#demo', label: 'Free demo' },
];

function SectionHead({ eyebrow, title, sub }: { eyebrow: string; title: React.ReactNode; sub?: string }) {
  return (
    <Reveal className="mx-auto mb-12 max-w-3xl text-center">
      <p className="mb-3 text-xs font-semibold tracking-[0.2em] text-emerald-400 uppercase">{eyebrow}</p>
      <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-5xl">{title}</h2>
      {sub && <p className="mt-4 text-base text-slate-400 sm:text-lg">{sub}</p>}
    </Reveal>
  );
}

function Spotlight({ title, eyebrow, body, points, demo, flip }: { title: string; eyebrow: string; body: string; points: string[]; demo: React.ReactNode; flip?: boolean }) {
  return (
    <div className={`grid items-center gap-10 lg:grid-cols-2 lg:gap-16 ${flip ? 'lg:[&>*:first-child]:order-2' : ''}`}>
      <Reveal>
        <p className="mb-3 text-xs font-semibold tracking-[0.2em] text-violet-300 uppercase">{eyebrow}</p>
        <h3 className="text-2xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h3>
        <p className="mt-4 text-slate-400">{body}</p>
        <ul className="mt-6 space-y-2.5">
          {points.map((p) => (
            <li key={p} className="flex items-start gap-2.5 text-sm text-slate-300">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                <Check className="h-3 w-3 text-emerald-400" strokeWidth={3} />
              </span>
              {p}
            </li>
          ))}
        </ul>
      </Reveal>
      <Reveal delay={150}>
        <div className="relative">
          <div className="absolute -inset-6 -z-10 rounded-[2rem] bg-gradient-to-tr from-emerald-500/20 via-violet-500/10 to-transparent blur-2xl" />
          {demo}
        </div>
      </Reveal>
    </div>
  );
}

export function LandingPage() {
  return (
    <div className="lp min-h-screen overflow-x-hidden bg-[#0d1117] text-slate-200 antialiased selection:bg-emerald-400/30">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-white/5 bg-[#0d1117]/70 backdrop-blur-xl">
        <nav className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-5">
          <Link href="/" className="flex items-center gap-2 font-semibold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 shadow-[0_0_24px_rgba(37,211,102,0.45)]">
              <MessageCircle className="h-4.5 w-4.5 text-black" />
            </span>
            wacrm
          </Link>
          <div className="hidden items-center gap-6 text-sm text-slate-400 md:flex">
            {NAV.map((n) => (
              <a key={n.href} href={n.href} className="transition-colors hover:text-white">
                {n.label}
              </a>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-1.5 text-sm text-slate-300 transition-colors hover:text-white">
              Sign in
            </Link>
            <a
              href={demoLink()}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-white px-3.5 py-1.5 text-sm font-medium text-black transition-transform hover:scale-[1.03]"
            >
              Book a free demo
            </a>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative pt-28 pb-10 sm:pt-36">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute top-[-10%] left-1/2 h-[700px] w-[1100px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(124,58,237,0.25),transparent)]" />
          <div className="absolute top-[30%] left-[10%] h-[400px] w-[500px] rounded-full bg-[radial-gradient(closest-side,rgba(37,211,102,0.16),transparent)]" />
          <div className="lp-stars absolute inset-0 opacity-60" />
        </div>
        <div className="mx-auto grid max-w-7xl items-center gap-10 px-5 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <Reveal>
              <a
                href="#pricing"
                className="mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300 transition-colors hover:border-emerald-400/40"
              >
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                Plans from ₹999/month · free live demo
                <ArrowRight className="h-3 w-3" />
              </a>
            </Reveal>
            <Reveal delay={80}>
              <h1 className="text-4xl leading-[1.05] font-semibold tracking-tight text-white sm:text-6xl lg:text-7xl">
                Grow your business on{' '}
                <span className="lp-gradient-text bg-gradient-to-r from-emerald-300 via-emerald-400 to-violet-400 bg-clip-text text-transparent">WhatsApp</span>
                , on autopilot.
              </h1>
            </Reveal>
            <Reveal delay={160}>
              <p className="mt-6 max-w-xl text-lg text-slate-400">
                Stop sending messages by hand. Automate follow-ups, payment reminders, appointment updates and campaigns — and manage every customer conversation from one place.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <div className="mt-8 flex flex-wrap gap-3">
                <a
                  href={demoLink()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-5 py-3 text-sm font-semibold text-black shadow-[0_0_40px_rgba(37,211,102,0.35)] transition-all hover:bg-emerald-300 hover:shadow-[0_0_60px_rgba(37,211,102,0.5)]"
                >
                  <MessageCircle className="h-4 w-4" />
                  Get a free live demo
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </a>
                <a
                  href="#pricing"
                  className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-white/10"
                >
                  See pricing
                </a>
              </div>
            </Reveal>
            <Reveal delay={320}>
              <p className="mt-6 text-xs text-slate-500">Official WhatsApp Business API · Works for retail, clinics, coaching, restaurants & services</p>
            </Reveal>
          </div>

          <div className="relative mx-auto aspect-square w-full max-w-[560px]">
            <Globe className="h-full w-full" />
            {/* Floating notifications */}
            <div className="absolute top-[12%] left-[-2%] animate-[lp-float_6s_ease-in-out_infinite] rounded-xl border border-white/10 bg-[#161b22]/90 px-3 py-2 text-xs shadow-xl backdrop-blur sm:left-[-6%]">
              <p className="font-medium text-white">💳 Payment link sent</p>
              <p className="text-slate-400">Asha · Pune · ✓✓ read</p>
            </div>
            <div className="absolute right-[-2%] bottom-[22%] animate-[lp-float_7s_ease-in-out_infinite_1s] rounded-xl border border-white/10 bg-[#161b22]/90 px-3 py-2 text-xs shadow-xl backdrop-blur">
              <p className="font-medium text-white">⏰ Webinar reminder</p>
              <p className="text-slate-400">2,140 leads · 7:00 PM IST</p>
            </div>
            <div className="absolute bottom-[4%] left-[8%] animate-[lp-float_8s_ease-in-out_infinite_2s] rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs shadow-xl backdrop-blur">
              <p className="font-medium text-emerald-200">↩ Lost lead wrote back</p>
              <p className="text-emerald-300/70">Team alerted · menu re-sent</p>
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="mx-auto mt-16 max-w-5xl px-5">
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4">
            {STATS.map((s) => (
              <div key={s.label} className="bg-[#0d1117] px-5 py-6 text-center">
                <p className="text-3xl font-semibold text-white sm:text-4xl">
                  <Counter value={s.value} prefix={'prefix' in s ? (s as { prefix?: string }).prefix : ''} suffix={s.suffix} />
                </p>
                <p className="mt-1 text-xs text-slate-500">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pain → promise */}
      <section className="relative py-20">
        <div className="mx-auto max-w-5xl px-5">
          <Reveal className="grid gap-4 md:grid-cols-3">
            {PAINS.map((p) => (
              <div key={p} className="rounded-2xl border border-rose-500/15 bg-rose-500/[0.04] p-5">
                <X className="mb-3 h-5 w-5 text-rose-400" />
                <p className="text-sm text-slate-300">{p}</p>
              </div>
            ))}
          </Reveal>
          <Reveal delay={120}>
            <p className="mt-8 text-center text-2xl font-semibold text-white sm:text-3xl">
              Work smarter, not harder. <span className="text-emerald-400">Let WhatsApp do the follow-ups.</span>
            </p>
          </Reveal>
        </div>
      </section>

      {/* Feature spotlights */}
      <section id="features" className="relative scroll-mt-20 py-20">
        <SectionHead
          eyebrow="Everything in one place"
          title={
            <>
              From first message to <span className="text-emerald-400">paid customer</span>
            </>
          }
          sub="One inbox, automated journeys and the tools to recover every message that didn’t land."
        />
        <div className="mx-auto max-w-6xl space-y-28 px-5">
          <Spotlight
            eyebrow="Shared inbox"
            title="Every conversation, one team inbox"
            body="Assign chats, see who’s online, reply with templates or AI drafts, and translate messages on the fly — while your journeys keep running in the background."
            points={['Assignment, presence and quick replies', 'AI drafts with your own OpenAI / Anthropic key', 'Translation and voice-note transcription']}
            demo={<div className="h-[380px]"><InboxDemo /></div>}
          />
          <Spotlight
            flip
            eyebrow="Journeys"
            title="Follow-ups that run themselves"
            body="Build funnels visually: confirmations, reminders at the right local time, payment nudges inside WhatsApp’s 24-hour window, and nurture that stops the moment someone pays."
            points={['Waits, “wait until”, branches, loops, HTTP and code steps', 'Daytime-only nudges, 11 AM nurture, closed-lost on day 15', 'Conversion numbers on every step']}
            demo={<div className="rounded-2xl border border-white/10 bg-[#0d1117] p-4 shadow-2xl"><JourneyDemo /></div>}
          />
          <Spotlight
            eyebrow="Recovery"
            title="Never lose a message Meta refused"
            body="See every failed send with the reason in plain words — then resend it, schedule it, or send it as a normal message while the customer’s 24-hour window is open."
            points={['Automatic retry of Meta-limited (131049) sends', 'Daily health summary and lead-feed alerts', 'Callback desk with “no answer” follow-ups']}
            demo={<RecoveryDemo />}
          />
          <Spotlight
            flip
            eyebrow="Team control"
            title="Roles that fit your organisation"
            body="Create roles like “Sales agent” or “Marketing” and decide, area by area, who can see and who can change what — enforced all the way down to the database."
            points={['None / View / Edit for 15 areas', 'Presets to start from, built on Admin, Agent or Viewer', 'Invite people straight into a role']}
            demo={<RolesDemo />}
          />
        </div>
      </section>

      {/* All features */}
      <section className="py-20">
        <SectionHead eyebrow="All features" title="Built for how Indian businesses sell on WhatsApp" />
        <SpotlightGrid className="mx-auto grid max-w-6xl gap-4 px-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => {
            const Icon = ICONS[f.icon] ?? Sparkles;
            return (
              <Reveal key={f.title} delay={(i % 3) * 80}>
                <div data-spotlight className="lp-spot group relative h-full overflow-hidden rounded-2xl border border-white/10 bg-[#161b22]/60 p-6 transition-colors hover:border-white/20">
                  <div className="mb-4 flex items-center justify-between">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 transition-transform group-hover:scale-110">
                      <Icon className="h-5 w-5 text-emerald-400" />
                    </span>
                    {f.tag && (
                      <span className="rounded-full border border-violet-400/30 bg-violet-400/10 px-2 py-0.5 text-[10px] font-medium text-violet-300">{f.tag}</span>
                    )}
                  </div>
                  <h3 className="font-semibold text-white">{f.title}</h3>
                  <p className="mt-2 text-sm text-slate-400">{f.body}</p>
                </div>
              </Reveal>
            );
          })}
        </SpotlightGrid>
      </section>

      {/* Industries */}
      <section className="overflow-hidden py-20">
        <SectionHead eyebrow="Built for" title="Whatever you run, communicate smarter" />
        <div className="lp-marquee-mask relative">
          <div className="flex w-max animate-[lp-marquee_40s_linear_infinite] gap-4 hover:[animation-play-state:paused]">
            {[...INDUSTRIES, ...INDUSTRIES].map((ind, i) => {
              const Icon = ICONS[ind.icon] ?? Store;
              return (
                <div key={`${ind.name}-${i}`} className="w-64 shrink-0 rounded-2xl border border-white/10 bg-[#161b22]/60 p-5">
                  <Icon className="h-6 w-6 text-emerald-400" />
                  <p className="mt-3 font-semibold text-white">{ind.name}</p>
                  <p className="mt-1 text-sm text-slate-400">{ind.use}</p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Compare */}
      <section id="compare" className="scroll-mt-20 py-20">
        <SectionHead
          eyebrow="Compare"
          title="More of what you need, for less"
          sub="How wacrm stacks up against AiSensy and WATI — including where they’re ahead."
        />
        <div className="mx-auto max-w-6xl px-5">
          <Reveal>
            <CompareTable />
          </Reveal>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="relative scroll-mt-20 py-20">
        <div className="pointer-events-none absolute inset-x-0 top-20 -z-10 mx-auto h-[500px] max-w-4xl rounded-full bg-[radial-gradient(closest-side,rgba(37,211,102,0.12),transparent)]" />
        <SectionHead eyebrow="Pricing" title="Simple monthly plans" sub="No setup fee. Every plan uses the official WhatsApp Business API. Upgrade any time." />
        <div className="mx-auto grid max-w-7xl gap-5 px-5 md:grid-cols-2 xl:grid-cols-4">
          {PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={i * 90} className="h-full">
              <div
                className={`relative flex h-full flex-col rounded-2xl border p-6 transition-transform hover:-translate-y-1 ${
                  plan.highlight ? 'lp-glow-border border-emerald-400/50 bg-gradient-to-b from-emerald-500/10 to-[#161b22]' : 'border-white/10 bg-[#161b22]/60'
                }`}
              >
                {plan.badge && (
                  <span className="absolute -top-3 left-6 rounded-full bg-emerald-400 px-3 py-0.5 text-[11px] font-semibold text-black">{plan.badge}</span>
                )}
                <p className="font-semibold text-white">{plan.name}</p>
                <p className="mt-1 text-sm text-slate-400">{plan.blurb}</p>
                <p className="mt-5 flex items-baseline gap-1">
                  <span className="text-4xl font-semibold tracking-tight text-white">{plan.price}</span>
                  <span className="text-sm text-slate-500">{plan.period}</span>
                </p>
                <a
                  href={demoLink(plan.name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`mt-5 rounded-xl px-4 py-2.5 text-center text-sm font-semibold transition-colors ${
                    plan.highlight ? 'bg-emerald-400 text-black hover:bg-emerald-300' : 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                  }`}
                >
                  {plan.cta}
                </a>
                {plan.includes && <p className="mt-6 text-xs font-medium text-slate-400">{plan.includes}</p>}
                <ul className={`${plan.includes ? 'mt-3' : 'mt-6'} space-y-2.5`}>
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-slate-300">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>

        <Reveal className="mx-auto mt-8 max-w-3xl px-5">
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-white/10 bg-[#161b22]/60 p-5 sm:flex-row sm:items-center">
            <Radio className="h-6 w-6 shrink-0 text-violet-300" />
            <p className="text-sm text-slate-300">
              <span className="font-semibold text-white">WhatsApp marketing messages</span> are charged separately at about{' '}
              <span className="font-semibold text-emerald-300">{MARKETING_MESSAGE_PRICE} per message</span>, based on WhatsApp’s (Meta’s) current rates. Replies within 24 hours of a
              customer’s message are free of Meta charges.
            </p>
          </div>
        </Reveal>

        {/* Price comparison */}
        <div className="mx-auto mt-16 max-w-5xl px-5">
          <Reveal>
            <h3 className="mb-5 text-center text-2xl font-semibold text-white">How our pricing compares</h3>
            <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#0d1117]/80">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="text-left">
                    <th className="px-5 py-3 text-xs font-medium tracking-wide text-slate-400 uppercase" />
                    <th className="bg-emerald-500/[0.06] px-4 py-3 font-semibold text-white">wacrm</th>
                    <th className="px-4 py-3 font-medium text-slate-300">AiSensy*</th>
                    <th className="px-4 py-3 font-medium text-slate-300">WATI*</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICE_COMPARE.map((r) => (
                    <tr key={r.label} className="border-t border-white/5">
                      <td className="px-5 py-3 text-slate-300">{r.label}</td>
                      <td className="bg-emerald-500/[0.06] px-4 py-3 font-medium text-emerald-200">{r.wacrm}</td>
                      <td className="px-4 py-3 text-slate-400">{r.aisensy}</td>
                      <td className="px-4 py-3 text-slate-400">{r.wati}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              *Competitor prices are from third-party reviews (they differ between sources and change over time) and exclude Meta message charges. Check each vendor’s site for
              current pricing:{' '}
              {PRICE_SOURCES.map((s, i) => (
                <span key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300">
                    {s.label}
                  </a>
                  {i < PRICE_SOURCES.length - 1 ? ', ' : '.'}
                </span>
              ))}
            </p>
          </Reveal>
        </div>
      </section>

      {/* Demo CTA */}
      <section id="demo" className="scroll-mt-20 px-5 py-24">
        <Reveal className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-[#123524] via-[#0d1117] to-[#1e1440] p-10 text-center sm:p-16">
          <div className="lp-stars pointer-events-none absolute inset-0 opacity-40" />
          <p className="relative text-xs font-semibold tracking-[0.2em] text-emerald-300 uppercase">See it before you subscribe</p>
          <h2 className="relative mt-4 text-3xl font-semibold tracking-tight text-white sm:text-5xl">Get a free live demo</h2>
          <p className="relative mx-auto mt-4 max-w-xl text-slate-300">
            Your business. Your customers. Your automation. Message us on WhatsApp and we’ll walk you through it with your own use case.
          </p>
          <div className="relative mt-8 flex flex-col items-center gap-3">
            <a
              href={demoLink()}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-6 py-3.5 font-semibold text-black shadow-[0_0_50px_rgba(37,211,102,0.4)] transition-all hover:bg-emerald-300"
            >
              <MessageCircle className="h-5 w-5" />
              WhatsApp {CONTACT.name}
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
            </a>
            <a href={`tel:+${CONTACT.phone}`} className="text-sm text-slate-400 hover:text-white">
              or call {CONTACT.phoneDisplay}
            </a>
          </div>
        </Reveal>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-5 text-sm text-slate-500 sm:flex-row">
          <p>© {new Date().getFullYear()} wacrm · Don’t just send messages. Build relationships.</p>
          <div className="flex gap-5">
            <a href="#pricing" className="hover:text-white">Pricing</a>
            <a href="#compare" className="hover:text-white">Compare</a>
            <Link href="/login" className="hover:text-white">Sign in</Link>
            <Link href="/signup" className="hover:text-white">Sign up</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
