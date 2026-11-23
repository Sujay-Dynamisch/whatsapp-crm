'use client';

// "Guide" button in each module's header: opens a plain-language guide
// for that module (content in src/lib/guides/content.ts).

import { useState } from 'react';
import { BookOpen, Lightbulb, Sparkles, Tag } from 'lucide-react';

import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { GUIDES, LEAD_TAGS, type GuideItem, type Tone } from '@/lib/guides/content';
import { cn } from '@/lib/utils';

const TONE: Record<Tone, string> = {
  amber: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  sky: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  rose: 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-400',
  emerald: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  violet: 'border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  muted: 'border-border bg-muted text-muted-foreground',
};

function Items({ items }: { items: GuideItem[] }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {items.map((it) => (
        <li key={it.label} className="flex flex-col gap-1 px-3.5 py-2.5 sm:flex-row sm:items-start sm:gap-3">
          <span
            className={cn(
              'w-fit shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-semibold sm:mt-0.5 sm:w-36 sm:truncate sm:text-center',
              TONE[it.tone ?? 'muted']
            )}
            title={it.label}
          >
            {it.label}
          </span>
          <span className="text-sm leading-relaxed text-foreground/90">{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Placed in each module's own header. `compact` = icon only (tight toolbars). */
export function PageGuide({ module, compact = false }: { module: string; compact?: boolean }) {
  const guide = GUIDES[module] ?? null;
  const [open, setOpen] = useState(false);
  if (!guide) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Guide: ${guide.title}`}
        title={`How ${guide.title} works`}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/8 text-xs font-medium text-primary transition-colors hover:bg-primary/15',
          compact ? 'h-9 w-9 justify-center' : 'h-7 px-2.5'
        )}
      >
        <BookOpen className="h-3.5 w-3.5" />
        {!compact && 'Guide'}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
          <SheetHeader className="relative overflow-hidden border-b border-border bg-gradient-to-br from-primary/15 via-violet-500/10 to-transparent p-6">
            <span className="mb-2 inline-flex w-fit items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
              <Sparkles className="h-3 w-3" /> Guide
            </span>
            <SheetTitle className="text-xl">{guide.title}</SheetTitle>
            <SheetDescription className="text-sm leading-relaxed">{guide.tagline}</SheetDescription>
          </SheetHeader>

          <div className="space-y-6 p-6">
            {guide.steps.length > 0 && (
              <section>
                <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">How to use it</h3>
                <ol className="space-y-2">
                  {guide.steps.map((s, i) => (
                    <li key={s} className="flex items-start gap-3">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-violet-500 text-[11px] font-bold text-white">
                        {i + 1}
                      </span>
                      <span className="pt-0.5 text-sm leading-relaxed text-foreground">{s}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {guide.sections.map((sec) => (
              <section key={sec.title}>
                <h3 className="mb-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{sec.title}</h3>
                <Items items={sec.items} />
              </section>
            ))}

            {guide.tags && (
              <section>
                <h3 className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                  <Tag className="h-3.5 w-3.5" /> Lead tags (added automatically)
                </h3>
                <Items items={LEAD_TAGS} />
              </section>
            )}

            {guide.tips.length > 0 && (
              <section className="rounded-xl border border-amber-500/30 bg-amber-500/8 p-4">
                <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber-800 dark:text-amber-300">
                  <Lightbulb className="h-4 w-4" /> Good to know
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-foreground/90">
                  {guide.tips.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
