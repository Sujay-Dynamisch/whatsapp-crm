'use client';

// Small, looping product demos for the landing page.

import { useEffect, useState } from 'react';
import { Check, CheckCheck } from 'lucide-react';

import { useReducedMotion } from './reveal';

// ---------- Inbox: a conversation that types itself ----------
const CHAT: { from: 'lead' | 'bot' | 'agent'; text: string; time: string }[] = [
  { from: 'bot', text: 'Hi Asha 👋 Your Transformation Webinar is tonight at 8:00 PM IST.', time: '2:00 PM' },
  { from: 'lead', text: 'Couldn’t attend 😕', time: '7:02 AM' },
  { from: 'bot', text: 'No worries! You’re booked for Wed, 8:00 PM — link inside 📅', time: '7:02 AM' },
  { from: 'lead', text: '1', time: '9:15 PM' },
  { from: 'bot', text: 'Great decision, Asha! 🎉 Here’s your link to join Revibe.', time: '9:15 PM' },
];

export function InboxDemo() {
  const reduce = useReducedMotion();
  const [step, setShown] = useState(2);
  const [typing, setTyping] = useState(false);
  const shown = reduce ? CHAT.length : step;
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => {
      setTyping(true);
      setTimeout(() => {
        setTyping(false);
        setShown((n) => (n >= CHAT.length ? 2 : n + 1));
      }, 900);
    }, 2400);
    return () => clearInterval(id);
  }, [reduce]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b141a] shadow-2xl">
      <div className="flex items-center gap-3 border-b border-white/5 bg-[#202c33] px-4 py-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500/20 text-sm font-semibold text-emerald-300">A</div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-white">Asha Patil</p>
          <p className="text-[11px] text-emerald-300/80">{typing ? 'typing…' : 'Journey · Webinar Funnel'}</p>
        </div>
        <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] text-emerald-300">Stage D</span>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-2 p-4 [background-image:radial-gradient(rgba(255,255,255,0.03)_1px,transparent_1px)] [background-size:14px_14px]">
        {CHAT.slice(0, shown).map((m, i) => (
          <div
            key={`${shown}-${i}`}
            className={`max-w-[82%] animate-[lp-pop_.35s_ease-out] rounded-xl px-3 py-2 text-[13px] leading-snug shadow ${
              m.from === 'lead' ? 'self-start rounded-tl-sm bg-[#202c33] text-white' : 'self-end rounded-tr-sm bg-[#005c4b] text-white'
            }`}
          >
            {m.text}
            <span className="ml-2 inline-flex items-center gap-0.5 align-bottom text-[10px] text-white/50">
              {m.time}
              {m.from !== 'lead' && <CheckCheck className="h-3 w-3 text-sky-400" />}
            </span>
          </div>
        ))}
        {typing && (
          <div className="flex gap-1 self-start rounded-xl rounded-tl-sm bg-[#202c33] px-3 py-2.5">
            {[0, 1, 2].map((d) => (
              <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60" style={{ animationDelay: `${d * 120}ms` }} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Journey: a graph with messages flowing through it ----------
const NODES = [
  { id: 'reg', label: 'Registered', sub: 'Website · API', x: 20, y: 30 },
  { id: 'msg', label: 'Msg 1–3', sub: 'Confirmation · reminders', x: 200, y: 30 },
  { id: 'menu', label: 'Check-in menu', sub: '7:00 AM next day', x: 380, y: 30 },
  { id: 'pay', label: 'Payment link', sub: '2 daytime nudges', x: 200, y: 150 },
  { id: 'nurture', label: 'Nurture', sub: '11 AM · every 2nd day', x: 380, y: 150 },
  { id: 'won', label: 'WON', sub: 'Tag: paid', x: 20, y: 150 },
];
const EDGES: [string, string][] = [
  ['reg', 'msg'],
  ['msg', 'menu'],
  ['menu', 'pay'],
  ['menu', 'nurture'],
  ['pay', 'won'],
  ['nurture', 'pay'],
];

export function JourneyDemo() {
  const reduce = useReducedMotion();
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setActive((a) => (a + 1) % NODES.length), 1100);
    return () => clearInterval(id);
  }, [reduce]);
  const pos = Object.fromEntries(NODES.map((n) => [n.id, n]));
  const W = 150;
  const H = 54;
  return (
    <svg viewBox="0 0 560 230" className="h-full w-full">
      <defs>
        <linearGradient id="lp-edge" x1="0" x2="1">
          <stop offset="0" stopColor="#25D366" />
          <stop offset="1" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      {EDGES.map(([a, b]) => {
        const A = pos[a];
        const B = pos[b];
        const x1 = A.x + W / 2;
        const y1 = A.y + H / 2;
        const x2 = B.x + W / 2;
        const y2 = B.y + H / 2;
        const d = `M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}`;
        return (
          <g key={`${a}-${b}`}>
            <path d={d} stroke="rgba(255,255,255,0.08)" strokeWidth="2" fill="none" />
            <path d={d} stroke="url(#lp-edge)" strokeWidth="2" fill="none" strokeDasharray="6 10" className={reduce ? '' : 'animate-[lp-dash_1.2s_linear_infinite]'} />
          </g>
        );
      })}
      {NODES.map((n, i) => (
        <g key={n.id} transform={`translate(${n.x},${n.y})`}>
          <rect
            width={W}
            height={H}
            rx="12"
            fill={i === active ? 'rgba(37,211,102,0.12)' : 'rgba(22,27,34,0.95)'}
            stroke={i === active ? '#25D366' : 'rgba(255,255,255,0.1)'}
            style={{ transition: 'all .4s ease' }}
          />
          <text x="14" y="23" fill="#e6edf3" fontSize="13" fontWeight="600">
            {n.label}
          </text>
          <text x="14" y="41" fill="#8b949e" fontSize="10.5">
            {n.sub}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ---------- Roles: a permission grid flipping between levels ----------
const ROLE_ROWS = ['Inbox', 'Contacts', 'Broadcasts', 'Journeys', 'Settings', 'Team & roles'];
const PATTERNS = [
  ['edit', 'edit', 'none', 'view', 'none', 'none'],
  ['view', 'view', 'edit', 'edit', 'none', 'none'],
  ['view', 'view', 'view', 'view', 'view', 'none'],
];
const ROLE_NAMES = ['Sales agent', 'Marketing', 'Read-only manager'];

export function RolesDemo() {
  const reduce = useReducedMotion();
  const [p, setP] = useState(0);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setP((x) => (x + 1) % PATTERNS.length), 2600);
    return () => clearInterval(id);
  }, [reduce]);
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1117] p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm font-semibold text-white">{ROLE_NAMES[p]}</p>
        <span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-slate-400">Base: {p === 2 ? 'Viewer' : 'Agent'}</span>
      </div>
      <ul className="space-y-1.5">
        {ROLE_ROWS.map((r, i) => (
          <li key={r} className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-1.5 text-xs">
            <span className="text-slate-300">{r}</span>
            <span className="flex gap-0.5 rounded-md bg-black/30 p-0.5">
              {(['none', 'view', 'edit'] as const).map((l) => (
                <span
                  key={l}
                  className={`w-11 rounded px-1 py-0.5 text-center transition-all duration-500 ${
                    PATTERNS[p][i] === l
                      ? l === 'edit'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : l === 'view'
                          ? 'bg-sky-500/20 text-sky-300'
                          : 'bg-white/10 text-slate-300'
                      : 'text-slate-600'
                  }`}
                >
                  {l === 'none' ? 'None' : l === 'view' ? 'View' : 'Edit'}
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Recovery: a failed send fixed in one click ----------
export function RecoveryDemo() {
  const reduce = useReducedMotion();
  const [fixed, setFixed] = useState(false);
  useEffect(() => {
    if (reduce) return;
    const id = setInterval(() => setFixed((f) => !f), 2200);
    return () => clearInterval(id);
  }, [reduce]);
  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1117] p-4 shadow-2xl">
      <div className={`rounded-xl border p-3 transition-all duration-500 ${fixed ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5'}`}>
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-white">Ravi Kumar</span>
          <span className="font-mono text-[10px] text-slate-400">sg_nurture_coldlead</span>
        </div>
        <p className={`mt-1.5 text-[11px] transition-colors ${fixed ? 'text-emerald-300' : 'text-rose-300'}`}>
          {fixed ? 'Sent as text while the 24h window is open' : '(131049) Meta limited marketing messages to this person'}
        </p>
        <div className="mt-2.5 flex gap-1.5">
          {['Resend', 'Schedule', 'Send as text'].map((b, i) => (
            <span
              key={b}
              className={`rounded-md border px-2 py-1 text-[10px] transition-all ${
                i === 2 && fixed ? 'border-emerald-400/50 bg-emerald-400/15 text-emerald-200' : 'border-white/10 text-slate-300'
              }`}
            >
              {b}
            </span>
          ))}
          {fixed && <Check className="ml-auto h-4 w-4 animate-[lp-pop_.3s_ease-out] text-emerald-400" />}
        </div>
      </div>
    </div>
  );
}
