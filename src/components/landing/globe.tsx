'use client';

// A rotating dotted globe with WhatsApp messages arcing between cities
// (canvas, no dependencies). Drag to spin. Still frame when the visitor
// prefers reduced motion; paused while off-screen.

import { useEffect, useRef } from 'react';

const CITIES: [number, number][] = [
  [19.07, 72.88], [28.61, 77.21], [12.97, 77.59], [18.52, 73.86], [22.57, 88.36], // Mumbai, Delhi, Bengaluru, Pune, Kolkata
  [25.2, 55.27], [51.51, -0.13], [40.71, -74.0], [-23.55, -46.63], [1.35, 103.82], // Dubai, London, New York, São Paulo, Singapore
  [37.57, 126.98], [-33.87, 151.21], [6.52, 3.38], [-26.2, 28.05], [19.43, -99.13], // Seoul, Sydney, Lagos, Johannesburg, Mexico City
  [3.14, 101.69], [-6.21, 106.85], [41.01, 28.98], [52.52, 13.4], [35.68, 139.69], // KL, Jakarta, Istanbul, Berlin, Tokyo
];

type V3 = [number, number, number];
const toVec = (lat: number, lon: number): V3 => {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
};
const slerp = (a: V3, b: V3, t: number): V3 => {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const om = Math.acos(dot);
  if (om < 1e-4) return a;
  const s = Math.sin(om);
  const k1 = Math.sin((1 - t) * om) / s;
  const k2 = Math.sin(t * om) / s;
  return [a[0] * k1 + b[0] * k2, a[1] * k1 + b[1] * k2, a[2] * k1 + b[2] * k2];
};

interface Arc {
  from: V3;
  to: V3;
  born: number;
  life: number;
}

export function Globe({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Dots on a Fibonacci sphere.
    const N = 2400;
    const dots: V3[] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const th = Math.PI * (3 - Math.sqrt(5)) * i;
      dots.push([Math.cos(th) * r, y, Math.sin(th) * r]);
    }
    const cities = CITIES.map(([la, lo]) => toVec(la, lo));

    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let rot = 1.2; // start over India
    let vel = reduce ? 0 : 0.0016;
    const tilt = 0.32;
    let dragging = false;
    let lastX = 0;
    const arcs: Arc[] = [];
    let nextArc = 0;

    const project = (v: V3) => {
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const x = v[0] * c - v[2] * s;
      const z0 = v[0] * s + v[2] * c;
      const ct = Math.cos(tilt);
      const st = Math.sin(tilt);
      const y = v[1] * ct - z0 * st;
      const z = v[1] * st + z0 * ct;
      const R = Math.min(w, h) * 0.42;
      return { x: w / 2 + x * R, y: h / 2 - y * R, z, R };
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      const R = Math.min(w, h) * 0.42;
      const cx = w / 2;
      const cy = h / 2;
      // Atmosphere (kept inside the canvas so it never shows as a square).
      const halo = Math.min(w, h) * 0.5;
      const g = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, halo);
      g.addColorStop(0, 'rgba(37, 211, 102, 0.22)');
      g.addColorStop(0.45, 'rgba(37, 211, 102, 0.06)');
      g.addColorStop(1, 'rgba(37, 211, 102, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, halo, 0, Math.PI * 2);
      ctx.fill();
      // Globe body, lit from the top-left, with a rim.
      const body = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, R * 0.1, cx, cy, R);
      body.addColorStop(0, '#17222e');
      body.addColorStop(1, '#0a0f15');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(37, 211, 102, 0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();

      for (const d of dots) {
        const p = project(d);
        if (p.z < -0.05) continue;
        const a = 0.15 + p.z * 0.65;
        ctx.fillStyle = `rgba(148, 163, 184, ${a})`;
        ctx.fillRect(p.x, p.y, 1.4, 1.4);
      }
      for (const c of cities) {
        const p = project(c);
        if (p.z < 0) continue;
        ctx.fillStyle = `rgba(37, 211, 102, ${0.5 + p.z * 0.5})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Message arcs.
      if (!reduce && t > nextArc) {
        const a = cities[Math.floor(Math.random() * cities.length)];
        let b = cities[Math.floor(Math.random() * cities.length)];
        if (a === b) b = cities[(cities.indexOf(a) + 3) % cities.length];
        arcs.push({ from: a, to: b, born: t, life: 2600 });
        nextArc = t + 380 + Math.random() * 420;
      }
      for (let i = arcs.length - 1; i >= 0; i--) {
        const arc = arcs[i];
        const k = (t - arc.born) / arc.life;
        if (k >= 1) {
          arcs.splice(i, 1);
          continue;
        }
        const head = Math.min(1, k * 1.6);
        const tail = Math.max(0, k * 1.6 - 0.6);
        ctx.beginPath();
        let started = false;
        const STEPS = 40;
        for (let s = 0; s <= STEPS; s++) {
          const u = tail + ((head - tail) * s) / STEPS;
          const v = slerp(arc.from, arc.to, u);
          const lift = 1 + Math.sin(u * Math.PI) * 0.32;
          const p = project([v[0] * lift, v[1] * lift, v[2] * lift]);
          if (p.z < -0.1) {
            started = false;
            continue;
          }
          if (!started) {
            ctx.moveTo(p.x, p.y);
            started = true;
          } else ctx.lineTo(p.x, p.y);
        }
        const grad = ctx.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, 'rgba(37, 211, 102, 0.9)');
        grad.addColorStop(1, 'rgba(167, 139, 250, 0.9)');
        ctx.strokeStyle = grad;
        ctx.globalAlpha = 1 - Math.max(0, k - 0.75) * 4;
        ctx.lineWidth = 1.6;
        ctx.stroke();
        // Landing pulse.
        if (head >= 1) {
          const p = project(arc.to);
          if (p.z > 0) {
            const rr = 3 + (k - 0.62) * 40;
            ctx.strokeStyle = 'rgba(37, 211, 102, 0.8)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(0, rr), 0, Math.PI * 2);
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
    };

    let raf = 0;
    let visible = true;
    const loop = (t: number) => {
      if (!dragging) {
        rot += vel;
        vel += ((reduce ? 0 : 0.0016) - vel) * 0.02; // ease back to cruise
      }
      draw(t);
      if (!reduce && visible) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const io = new IntersectionObserver(([e]) => {
      const was = visible;
      visible = e.isIntersecting;
      if (visible && !was && !reduce) raf = requestAnimationFrame(loop);
    });
    io.observe(canvas);

    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      rot += dx * 0.006;
      vel = dx * 0.0008;
      if (reduce) draw(performance.now());
    };
    const up = () => {
      dragging = false;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
  }, []);

  return <canvas ref={ref} className={className} style={{ touchAction: 'pan-y', cursor: 'grab' }} aria-label="Messages travelling around the globe" role="img" />;
}
