'use client';

// Fade/slide children in when they scroll into view (once).

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

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

export function Reveal({ children, delay = 0, className = '' }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [seen, setSeen] = useState(false);
  const shown = seen || reduce;
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -10% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reduce]);
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={`transition-all duration-700 ease-out ${shown ? 'translate-y-0 opacity-100 blur-0' : 'translate-y-6 opacity-0 blur-[2px]'} ${className}`}
    >
      {children}
    </div>
  );
}

/** Count up to `value` when visible. */
export function Counter({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const [count, setN] = useState(0);
  const n = reduce ? value : count;
  useEffect(() => {
    const el = ref.current;
    if (!el || reduce) return;
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const tick = (t: number) => {
        const k = Math.min(1, (t - start) / 1200);
        setN(Math.round(value * (1 - Math.pow(1 - k, 3))));
        if (k < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, reduce]);
  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {n.toLocaleString('en-IN')}
      {suffix}
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
