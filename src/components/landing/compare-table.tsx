'use client';

// Feature comparison with AiSensy and WATI. "Only differences" hides rows
// where all three are the same.

import { useState } from 'react';
import { Check, CircleDashed, Minus, X } from 'lucide-react';

import { COMPARE, COMPARE_CHECKED, COMPARE_SOURCES, type Cell } from './content';

function CellView({ cell, ours }: { cell: Cell; ours?: boolean }) {
  if (cell.v === 'text') return <span className={`text-xs ${ours ? 'font-medium text-white' : 'text-slate-300'}`}>{cell.note}</span>;
  if (cell.v === 'unknown') return <span className="inline-flex items-center gap-1 text-[11px] text-slate-500"><CircleDashed className="h-3.5 w-3.5" />Not listed</span>;
  const icon =
    cell.v === 'yes' ? (
      <span className={`flex h-5 w-5 items-center justify-center rounded-full ${ours ? 'bg-emerald-400 text-black' : 'bg-emerald-500/15 text-emerald-400'}`}>
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    ) : cell.v === 'partial' ? (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-500/15 text-amber-400">
        <Minus className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    ) : (
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/5 text-slate-500">
        <X className="h-3.5 w-3.5" strokeWidth={3} />
      </span>
    );
  return (
    <span className="inline-flex flex-col items-center gap-1">
      {icon}
      {'note' in cell && cell.note && <span className="max-w-[11rem] text-center text-[10.5px] leading-tight text-slate-400">{cell.note}</span>}
    </span>
  );
}

const same = (a: Cell, b: Cell) => a.v === b.v && ('note' in a ? a.note : '') === ('note' in b ? b.note : '');

export function CompareTable() {
  const [onlyDiff, setOnlyDiff] = useState(false);
  return (
    <div>
      <div className="mb-4 flex justify-end">
        <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300 select-none">
          <span>Only show differences</span>
          <button
            type="button"
            role="switch"
            aria-checked={onlyDiff}
            onClick={() => setOnlyDiff((x) => !x)}
            className={`relative h-5 w-9 rounded-full transition-colors ${onlyDiff ? 'bg-emerald-500' : 'bg-white/15'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${onlyDiff ? 'left-[18px]' : 'left-0.5'}`} />
          </button>
        </label>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#0d1117]/80 backdrop-blur">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="sticky top-0 z-10 bg-[#0d1117]">
              <th className="w-[38%] px-5 py-4 text-left text-xs font-medium tracking-wide text-slate-400 uppercase">Capability</th>
              <th className="relative px-3 py-4 text-center">
                <span className="absolute inset-x-2 top-0 bottom-0 -z-0 rounded-t-xl bg-gradient-to-b from-emerald-500/15 to-transparent" />
                <span className="relative font-semibold text-white">wacrm</span>
              </th>
              <th className="px-3 py-4 text-center font-medium text-slate-300">AiSensy</th>
              <th className="px-3 py-4 text-center font-medium text-slate-300">WATI</th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((g) => {
              const rows = g.rows.filter((r) => !onlyDiff || !(same(r.wacrm, r.aisensy) && same(r.wacrm, r.wati)));
              if (!rows.length) return null;
              return [
                <tr key={g.group}>
                  <td colSpan={4} className="border-t border-white/5 bg-white/[0.02] px-5 py-2 text-[11px] font-semibold tracking-wider text-emerald-300/80 uppercase">
                    {g.group}
                  </td>
                </tr>,
                ...rows.map((r) => (
                  <tr key={r.feature} className="border-t border-white/5 transition-colors hover:bg-white/[0.025]">
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-100">{r.feature}</p>
                      {r.detail && <p className="mt-0.5 text-xs text-slate-500">{r.detail}</p>}
                    </td>
                    <td className="bg-emerald-500/[0.04] px-3 py-3 text-center"><CellView cell={r.wacrm} ours /></td>
                    <td className="px-3 py-3 text-center"><CellView cell={r.aisensy} /></td>
                    <td className="px-3 py-3 text-center"><CellView cell={r.wati} /></td>
                  </tr>
                )),
              ];
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        Competitor details come from their public websites, help centres and third-party reviews, checked {COMPARE_CHECKED}, and may have changed. “Not listed” means we
        couldn’t find it publicly — not that it doesn’t exist. *Prices vary by source. Please check each vendor before deciding. Sources:{' '}
        {COMPARE_SOURCES.map((s, i) => (
          <span key={s.url}>
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline decoration-slate-600 underline-offset-2 hover:text-slate-300">
              {s.label}
            </a>
            {i < COMPARE_SOURCES.length - 1 ? ', ' : '.'}
          </span>
        ))}
      </p>
    </div>
  );
}
