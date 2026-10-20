'use client';

import { useRef } from 'react';
import { Braces, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { VarGroup, VarSuggestion } from '@/lib/journeys/variables';

const GROUP_ORDER: VarGroup[] = ['trigger', 'reply', 'loop', 'vars', 'steps', 'contact', 'other'];

/** "{ }" menu listing the variables a step can use. */
export function VariablePicker({
  suggestions,
  onPick,
  className,
}: {
  suggestions: VarSuggestion[];
  onPick: (placeholder: string) => void;
  className?: string;
}) {
  const t = useTranslations('Journeys');
  const groups = GROUP_ORDER.map((g) => ({ g, items: suggestions.filter((s) => s.group === g) })).filter(
    (x) => x.items.length > 0
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn('h-7 w-7 shrink-0 text-muted-foreground', className)}
            aria-label={t('vars.insert')}
            title={t('vars.insert')}
          />
        }
      >
        <Braces className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-72 overflow-y-auto">
        {groups.map(({ g, items }, i) => (
          <DropdownMenuGroup key={g}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel>{t(`vars.group.${g}`)}</DropdownMenuLabel>
            {items.map((s) => (
              <DropdownMenuItem key={s.path} onClick={() => onPick(`{{ ${s.path} }}`)} className="flex-col items-start gap-0">
                <code className="text-xs">{s.path}</code>
                {s.hint && <span className="text-[11px] text-muted-foreground">{s.hint}</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function insertAt(el: HTMLInputElement | HTMLTextAreaElement | null, value: string, text: string): [string, number] {
  const start = el?.selectionStart ?? value.length;
  const end = el?.selectionEnd ?? value.length;
  return [value.slice(0, start) + text + value.slice(end), start + text.length];
}

/** One-line input that accepts {{ expressions }}. */
export function ExprInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: VarSuggestion[];
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Input
        ref={ref}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-xs"
        {...rest}
      />
      <VariablePicker
        suggestions={suggestions}
        onPick={(p) => {
          const [next, caret] = insertAt(ref.current, value, p);
          onChange(next);
          requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.setSelectionRange(caret, caret);
          });
        }}
      />
    </div>
  );
}

/** Multi-line input that accepts {{ expressions }}. */
export function ExprTextarea({
  value,
  onChange,
  suggestions,
  rows = 4,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  suggestions: VarSuggestion[];
  rows?: number;
  placeholder?: string;
  mono?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <div className="relative">
      <Textarea
        ref={ref}
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn('pr-9', mono && 'font-mono text-xs')}
        spellCheck={!mono}
      />
      <VariablePicker
        className="absolute right-1 top-1"
        suggestions={suggestions}
        onPick={(p) => {
          const [next, caret] = insertAt(ref.current, value, p);
          onChange(next);
          requestAnimationFrame(() => {
            ref.current?.focus();
            ref.current?.setSelectionRange(caret, caret);
          });
        }}
      />
    </div>
  );
}

export interface KV {
  key: string;
  value: string;
}

/** Editable key → value rows (headers, query, form fields, variables). */
export function KeyValueList({
  rows,
  onChange,
  suggestions,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  renderKey,
  max = 30,
}: {
  rows: KV[];
  onChange: (rows: KV[]) => void;
  suggestions: VarSuggestion[];
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel: string;
  /** Replace the key input (e.g. a field select). */
  renderKey?: (row: KV, set: (key: string) => void) => React.ReactNode;
  max?: number;
}) {
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <div className="w-2/5 shrink-0">
            {renderKey ? (
              renderKey(row, (key) => set(i, { key }))
            ) : (
              <Input
                value={row.key}
                placeholder={keyPlaceholder}
                onChange={(e) => set(i, { key: e.target.value })}
                className="font-mono text-xs"
              />
            )}
          </div>
          <ExprInput
            className="min-w-0 flex-1"
            value={row.value}
            onChange={(value) => set(i, { value })}
            suggestions={suggestions}
            placeholder={valuePlaceholder}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-9 w-7 shrink-0 text-muted-foreground"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            aria-label="Remove"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      {rows.length < max && (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          <Plus className="h-3.5 w-3.5" />
          {addLabel}
        </Button>
      )}
    </div>
  );
}
