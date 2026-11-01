'use client';

// Phone/tablet menu for the landing nav (the inline links show from md up).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Menu, X } from 'lucide-react';

export function MobileMenu({
  links,
  demoHref,
}: {
  links: { href: string; label: string }[];
  demoHref: string;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // Close if the screen grows past the breakpoint (rotation, resize).
    const mq = window.matchMedia('(min-width: 768px)');
    const onMq = () => mq.matches && setOpen(false);
    window.addEventListener('keydown', onKey);
    mq.addEventListener('change', onMq);
    return () => {
      window.removeEventListener('keydown', onKey);
      mq.removeEventListener('change', onMq);
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls="lp-mobile-menu"
        aria-label={open ? 'Close menu' : 'Open menu'}
        className="-mr-1.5 flex h-10 w-10 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>
      {open && (
        <div
          id="lp-mobile-menu"
          className="absolute inset-x-0 top-full max-h-[calc(100dvh-4rem)] overflow-y-auto border-b border-white/10 bg-[#0d1117] px-5 pt-2 pb-5 shadow-[0_24px_48px_rgba(0,0,0,0.6)] animate-[lp-pop_.18s_ease-out]"
        >
          <ul className="flex flex-col">
            {links.map((n) => (
              <li key={n.href}>
                <a
                  href={n.href}
                  onClick={() => setOpen(false)}
                  className="block border-b border-white/5 py-3 text-base text-slate-300 transition-colors hover:text-white"
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Link
              href="/login"
              className="rounded-xl border border-white/15 px-4 py-2.5 text-center text-sm font-medium text-white hover:bg-white/10"
            >
              Sign in
            </Link>
            <a
              href={demoHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="rounded-xl bg-white px-4 py-2.5 text-center text-sm font-semibold text-black"
            >
              Book a demo
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
