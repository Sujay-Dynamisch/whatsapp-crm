'use client';

// Fade/slide children in when they scroll into view (once).

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';
/** The visitor's "reduce motion" setting (false on the server). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCE_QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false
  );
}

/**
 * Fade / slide children in when they scroll into view (once).
 *
 * The server renders everything visible, so content shows before any
 * JavaScript runs (fast first paint / LCP, works without JS). After
 * mount, only elements still below the viewport are hidden and then
 * revealed on scroll — what's already on screen never flickers.
 */
export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return; // already in view
    el.classList.add('lp-reveal-hidden');
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e.isIntersecting) return;
        el.classList.remove('lp-reveal-hidden');
        io.disconnect();
      },
      { rootMargin: '0px 0px -10% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);
  return (
    <div ref={ref} style={delay ? { transitionDelay: `${delay}ms` } : undefined} className={`lp-reveal ${className}`}>
      {children}
    </div>
  );
}

/** Shows `value`; counts up to it if it scrolls into view later. */
export function Counter({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const fmt = (n: number) => `${prefix}${n.toLocaleString('en-IN')}${suffix}`;
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.textContent = fmt(0);
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - start) / 1200);
        el.textContent = fmt(Math.round(value * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);
  return (
    <span ref={ref} className="tabular-nums">
      {fmt(value)}
    </span>
  );
}

/** A card grid whose cards light up under the cursor. */
export function SpotlightGrid({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={className}
      onMouseMove={(e) => {
        for (const card of Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-spotlight]'))) {
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${e.clientX - r.left}px`);
          card.style.setProperty('--my', `${e.clientY - r.top}px`);
        }
      }}
    >
      {children}
    </div>
  );
}
