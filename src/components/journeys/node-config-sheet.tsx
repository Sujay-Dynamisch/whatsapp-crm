'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, FlaskConical, Loader2, Plus, Trash2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  COMPARE_OPS,
  CONDITION_KINDS,
  CONTACT_FIELDS,
  HTTP_METHODS,
  TRIGGER_TYPES,
  UNARY_OPS,
  type CompareOp,
  type DurationUnit,
  type GraphIssue,
  type JourneyGraph,
  type JourneyNode,
  type NodeConfigs,
} from '@/lib/journeys/graph';
import { variableSuggestions } from '@/lib/journeys/variables';
import { ExprInput, ExprTextarea, KeyValueList } from './expression-input';
import { NODE_ACCENT, NODE_ICON } from './node-meta';

export interface LookupLists {
  templates: { name: string; language: string; body_text?: string }[];
  tags: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string; pipeline_name: string }[];
  members: { id: string; name: string }[];
  customFields: { id: string; name: string }[];
}

const selectClass = 'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground';

/** Steps the editor can execute against saved run data. */
const TESTABLE = new Set([
  'set_variable',
  'switch',
  'condition',
  'loop',
  'http_request',
  'code',
  'send_text',
  'send_template',
  'send_media',
  'send_buttons',
  'update_contact',
  'create_deal',
]);

interface TestResult {
  output?: unknown;
  slot?: string;
  error?: string;
  logs?: string[];
  dryRun?: boolean;
  run_id?: string | null;
}

function Field({ label, children, help }: { label: string; children: React.ReactNode; help?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}

export function NodeConfigSheet({
  node,
  graph,
  journeyId,
  lists,
  issues,
  webhookUrl,
  onChange,
  onDelete,
  onClose,
}: {
  node: JourneyNode | null;
  graph: JourneyGraph;
  journeyId: string;
  lists: LookupLists;
  issues: GraphIssue[];
  webhookUrl: string | null;
  onChange: (node: JourneyNode) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('Journeys');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => setResult(null), [node?.id]);

  const suggestions = useMemo(
    () => (node ? variableSuggestions(graph, node.id, lists.customFields.map((f) => f.name)) : []),
    [graph, node, lists.customFields]
  );

  if (!node) return null;

  const set = (patch: Record<string, unknown>) =>
    onChange({ ...node, config: { ...(node.config as object), ...patch } as never });
  const c = node.config as Record<string, unknown>;
  const nodeIssues = issues.filter((i) => i.nodeId === node.id);
  const Icon = NODE_ICON[node.type];

  async function runTest() {
    if (!node) return;
    setTesting(true);
    setResult(null);
    try {
      const res = await fetch(`/api/journeys/${journeyId}/test-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node }),
      });
      const data = await res.json().catch(() => ({}));
      setResult(res.ok ? data : { error: data?.error || `HTTP ${res.status}` });
    } finally {
      setTesting(false);
    }
  }

  const tagSelect = (value: unknown, key = 'tag_id') => (
    <select className={selectClass} value={String(value ?? '')} onChange={(e) => set({ [key]: e.target.value })}>
      <option value="">{t('form.chooseTag')}</option>
      {lists.tags.map((tag) => (
        <option key={tag.id} value={tag.id}>
          {tag.name}
        </option>
      ))}
    </select>
  );

  const opSelect = (value: CompareOp | undefined, onPick: (op: CompareOp) => void) => (
    <select className={selectClass} value={value ?? 'equals'} onChange={(e) => onPick(e.target.value as CompareOp)}>
      {COMPARE_OPS.map((op) => (
        <option key={op} value={op}>
          {t(`op.${op}`)}
        </option>
      ))}
    </select>
  );

  const duration = () => (
    <div className="grid grid-cols-2 gap-2">
      <Input
        type="number"
        min={1}
        value={Number(c.amount ?? 1)}
        onChange={(e) => set({ amount: Number(e.target.value) })}
        aria-label={t('form.amount')}
      />
      <select className={selectClass} value={String(c.unit ?? 'days')} onChange={(e) => set({ unit: e.target.value as DurationUnit })}>
        {(['minutes', 'hours', 'days'] as const).map((u) => (
          <option key={u} value={u}>
            {t(`unit.${u}`)}
          </option>
        ))}
      </select>
    </div>
  );

  let body: React.ReactNode = null;
  switch (node.type) {
    case 'trigger': {
      const cfg = c as unknown as NodeConfigs['trigger'];
      const browserTz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC';
      body = (
        <>
          <Field label={t('form.startsWhen')}>
            <select
              className={selectClass}
              value={cfg.trigger_type}
              onChange={(e) => {
                const trigger_type = e.target.value as NodeConfigs['trigger']['trigger_type'];
                set(
                  trigger_type === 'schedule'
                    ? { trigger_type, mode: cfg.mode ?? 'daily', time: cfg.time ?? '10:00', timezone: cfg.timezone ?? browserTz, every: cfg.every ?? 1, unit: cfg.unit ?? 'hours' }
                    : trigger_type === 'webhook'
                      ? { trigger_type, phone: cfg.phone ?? '{{ trigger.body.phone }}', name: cfg.name ?? '{{ trigger.body.name }}' }
                      : { trigger_type }
                );
              }}
            >
              {TRIGGER_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {t(`trigger.${tt}`)}
                </option>
              ))}
            </select>
          </Field>
          {cfg.trigger_type === 'tag_added' && <Field label={t('form.tag')}>{tagSelect(cfg.tag_id)}</Field>}
          {cfg.trigger_type === 'button_clicked' && (
            <Field label={t('form.buttonText')}>
              <Input value={cfg.button_text ?? ''} onChange={(e) => set({ button_text: e.target.value })} placeholder={t('form.anyButton')} />
            </Field>
          )}
          {cfg.trigger_type === 'manual' && <p className="text-xs text-muted-foreground">{t('form.manualHelp')}</p>}
          {cfg.trigger_type === 'inbound_message' && (
            <>
              <Field label={t('form.keyword')} help={t('form.keywordHelp')}>
                <Input value={cfg.keyword ?? ''} onChange={(e) => set({ keyword: e.target.value })} placeholder={t('form.anyMessage')} />
              </Field>
              {cfg.keyword?.trim() && (
                <Field label={t('form.matchType')}>
                  <select className={selectClass} value={cfg.match_type ?? 'contains'} onChange={(e) => set({ match_type: e.target.value })}>
                    <option value="contains">{t('form.matchContains')}</option>
                    <option value="exact">{t('form.matchExact')}</option>
                  </select>
                </Field>
              )}
            </>
          )}
          {cfg.trigger_type === 'webhook' && (
            <>
              <Field label={t('form.webhookUrl')} help={webhookUrl ? t('form.webhookUrlHelp') : t('form.webhookSaveFirst')}>
                {webhookUrl ? (
                  <div className="space-y-2">
                    <code className="block break-all rounded-md border border-border bg-muted/50 px-2 py-1.5 text-xs">{webhookUrl}</code>
                    <CopyButton text={webhookUrl} label={t('form.copyUrl')} />
                  </div>
                ) : null}
              </Field>
              <Field label={t('form.webhookPhone')} help={t('form.webhookPhoneHelp')}>
                <ExprInput value={cfg.phone ?? ''} onChange={(phone) => set({ phone })} suggestions={suggestions} />
              </Field>
              <Field label={t('form.webhookName')}>
                <ExprInput value={cfg.name ?? ''} onChange={(name) => set({ name })} suggestions={suggestions} />
              </Field>
              <Field label={t('form.defaultCountry')} help={t('form.defaultCountryHelp')}>
                <Input
                  inputMode="numeric"
                  value={cfg.default_country_code ?? ''}
                  onChange={(e) => set({ default_country_code: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                  placeholder="91"
                />
              </Field>
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-xs">
                <p className="mb-1 font-medium">{t('form.webhookExample')}</p>
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-muted-foreground">{`POST ${webhookUrl ?? '<url>'}
Content-Type: application/json

{ "phone": "+919876543210", "name": "Asha", "order": { "id": "A-1", "total": 1499 } }`}</pre>
              </div>
            </>
          )}
          {cfg.trigger_type === 'schedule' && (
            <>
              <Field label={t('form.audience')} help={t('form.audienceHelp')}>
                {tagSelect(cfg.tag_id)}
              </Field>
              <Field label={t('form.repeat')}>
                <select className={selectClass} value={cfg.mode ?? 'daily'} onChange={(e) => set({ mode: e.target.value })}>
                  <option value="interval">{t('form.repeatInterval')}</option>
                  <option value="daily">{t('form.repeatDaily')}</option>
                  <option value="weekly">{t('form.repeatWeekly')}</option>
                </select>
              </Field>
              {cfg.mode === 'interval' ? (
                <Field label={t('form.every')}>
                  <div className="grid grid-cols-2 gap-2">
                    <Input type="number" min={1} value={Number(cfg.every ?? 1)} onChange={(e) => set({ every: Number(e.target.value) })} />
                    <select className={selectClass} value={cfg.unit ?? 'hours'} onChange={(e) => set({ unit: e.target.value })}>
                      <option value="minutes">{t('unit.minutes')}</option>
                      <option value="hours">{t('unit.hours')}</option>
                    </select>
                  </div>
                </Field>
              ) : (
                <>
                  <Field label={t('form.atTime')}>
                    <Input type="time" value={cfg.time ?? '10:00'} onChange={(e) => set({ time: e.target.value })} />
                  </Field>
                  {cfg.mode === 'weekly' && (
                    <Field label={t('form.onDays')}>
                      <div className="flex flex-wrap gap-1">
                        {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                          const on = (cfg.days ?? []).includes(d);
                          return (
                            <button
                              key={d}
                              type="button"
                              onClick={() => set({ days: on ? (cfg.days ?? []).filter((x) => x !== d) : [...(cfg.days ?? []), d] })}
                              className={cn(
                                'h-8 min-w-10 rounded-md border px-2 text-xs font-medium',
                                on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'
                              )}
                            >
                              {t(`day.${d}`)}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                  )}
                </>
              )}
              <Field label={t('form.timezone')}>
                <Input value={cfg.timezone ?? browserTz} onChange={(e) => set({ timezone: e.target.value })} placeholder="Asia/Kolkata" />
              </Field>
            </>
          )}
          {lists.tags.length > 0 && (
            <Field label={t('form.exitTags')} help={t('form.exitTagsHelp')}>
              <div className="flex flex-wrap gap-1.5">
                {lists.tags.map((tag) => {
                  const ids = cfg.exit_tag_ids ?? [];
                  const on = ids.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => set({ exit_tag_ids: on ? ids.filter((x) => x !== tag.id) : [...ids, tag.id] })}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs',
                        on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground'
                      )}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </>
      );
      break;
    }
    case 'wait':
      body = (
        <>
          <Field label={t('form.waitFor')}>{duration()}</Field>
          <Field label={t('form.waitUntil')} help={t('form.waitUntilHelp')}>
            <ExprInput value={String(c.until ?? '')} onChange={(until) => set({ until })} suggestions={suggestions} />
          </Field>
        </>
      );
      break;
    case 'wait_for_reply':
      body = (
        <Field label={t('form.giveUpAfter')} help={t('form.waitReplyHelp')}>
          {duration()}
        </Field>
      );
      break;
    case 'condition': {
      const cfg = c as NodeConfigs['condition'];
      body = (
        <>
          <Field label={t('form.check')}>
            <select className={selectClass} value={cfg.kind} onChange={(e) => set({ kind: e.target.value })}>
              {CONDITION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {t(`condition.${k}`)}
                </option>
              ))}
            </select>
          </Field>
          {cfg.kind === 'has_tag' && <Field label={t('form.tag')}>{tagSelect(cfg.tag_id)}</Field>}
          {cfg.kind === 'clicked_button' && (
            <Field label={t('form.buttonText')}>
              <Input value={cfg.button_text ?? ''} onChange={(e) => set({ button_text: e.target.value })} placeholder={t('form.anyButton')} />
            </Field>
          )}
          {cfg.kind === 'expression' && (
            <>
              <Field label={t('form.value')}>
                <ExprInput value={cfg.left ?? ''} onChange={(left) => set({ left })} suggestions={suggestions} placeholder="{{ reply.text }}" />
              </Field>
              <Field label={t('form.comparison')}>{opSelect(cfg.op, (op) => set({ op }))}</Field>
              {!UNARY_OPS.includes(cfg.op ?? 'equals') && (
                <Field label={t('form.compareTo')}>
                  <ExprInput value={cfg.right ?? ''} onChange={(right) => set({ right })} suggestions={suggestions} />
                </Field>
              )}
            </>
          )}
        </>
      );
      break;
    }
    case 'switch': {
      const cfg = c as NodeConfigs['switch'];
      const cases = cfg.cases ?? [];
      const removeCase = (i: number) => {
        // Re-key connections so later cases keep their targets.
        const next: Record<string, string | undefined> = { default: node.next.default };
        cases.forEach((_, j) => {
          if (j < i) next[`case_${j}`] = node.next[`case_${j}`];
          if (j > i) next[`case_${j - 1}`] = node.next[`case_${j}`];
        });
        onChange({ ...node, next, config: { ...cfg, cases: cases.filter((_, j) => j !== i) } as never });
      };
      body = (
        <>
          <Field label={t('form.routeOn')} help={t('form.switchHelp')}>
            <ExprInput value={cfg.value ?? ''} onChange={(value) => set({ value })} suggestions={suggestions} />
          </Field>
          <div className="space-y-2">
            <Label>{t('form.cases')}</Label>
            {cases.map((k, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-border p-2">
                <div className="flex items-center gap-1.5">
                  <span className="w-6 text-xs font-semibold text-muted-foreground">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    {opSelect(k.op, (op) => set({ cases: cases.map((x, j) => (j === i ? { ...x, op } : x)) }))}
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeCase(i)} aria-label={t('form.removeCase')}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {!UNARY_OPS.includes(k.op) && (
                  <ExprInput
                    value={k.value ?? ''}
                    onChange={(value) => set({ cases: cases.map((x, j) => (j === i ? { ...x, value } : x)) })}
                    suggestions={suggestions}
                    placeholder={t('form.caseValue')}
                  />
                )}
                <Input
                  value={k.label ?? ''}
                  onChange={(e) => set({ cases: cases.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                  placeholder={t('form.caseLabel')}
                  className="h-8 text-xs"
                />
              </div>
            ))}
            {cases.length < 10 && (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ cases: [...cases, { op: 'equals', value: '' }] })}>
                <Plus className="h-3.5 w-3.5" />
                {t('form.addCase')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('form.switchDefault')}</p>
          </div>
        </>
      );
      break;
    }
    case 'loop': {
      const cfg = c as NodeConfigs['loop'];
      body = (
        <>
          <Field label={t('form.loopItems')} help={t('form.loopHelp')}>
            <ExprInput value={cfg.items ?? ''} onChange={(items) => set({ items })} suggestions={suggestions} placeholder="{{ trigger.body.items }}" />
          </Field>
          <Field label={t('form.loopMax')}>
            <Input type="number" min={1} max={100} value={Number(cfg.max ?? 50)} onChange={(e) => set({ max: Number(e.target.value) })} />
          </Field>
        </>
      );
      break;
    }
    case 'set_variable': {
      const cfg = c as NodeConfigs['set_variable'];
      body = (
        <Field label={t('form.variables')} help={t('form.variablesHelp')}>
          <KeyValueList
            rows={cfg.assignments ?? []}
            onChange={(assignments) => set({ assignments })}
            suggestions={suggestions}
            keyPlaceholder="coupon"
            valuePlaceholder="DIWALI20"
            addLabel={t('form.addVariable')}
          />
        </Field>
      );
      break;
    }
    case 'http_request': {
      const cfg = c as NodeConfigs['http_request'];
      body = (
        <>
          <div className="grid grid-cols-[110px_1fr] gap-2">
            <Field label={t('form.method')}>
              <select className={selectClass} value={cfg.method} onChange={(e) => set({ method: e.target.value })}>
                {HTTP_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="URL">
              <ExprInput value={cfg.url ?? ''} onChange={(url) => set({ url })} suggestions={suggestions} placeholder="https://api.example.com/orders/{{ trigger.body.id }}" />
            </Field>
          </div>
          <Field label={t('form.queryParams')}>
            <KeyValueList rows={cfg.query ?? []} onChange={(query) => set({ query })} suggestions={suggestions} keyPlaceholder="key" addLabel={t('form.addParam')} />
          </Field>
          <Field label={t('form.headers')} help={t('form.headersHelp')}>
            <KeyValueList rows={cfg.headers ?? []} onChange={(headers) => set({ headers })} suggestions={suggestions} keyPlaceholder="Authorization" valuePlaceholder="Bearer …" addLabel={t('form.addHeader')} />
          </Field>
          {cfg.method !== 'GET' && (
            <>
              <Field label={t('form.bodyType')}>
                <select className={selectClass} value={cfg.body_type ?? 'none'} onChange={(e) => set({ body_type: e.target.value })}>
                  <option value="none">{t('form.bodyNone')}</option>
                  <option value="json">JSON</option>
                  <option value="form">{t('form.bodyForm')}</option>
                  <option value="raw">{t('form.bodyRaw')}</option>
                </select>
              </Field>
              {cfg.body_type === 'json' && (
                <Field label={t('form.body')} help={t('form.jsonBodyHelp')}>
                  <ExprTextarea
                    mono
                    rows={7}
                    value={cfg.body ?? ''}
                    onChange={(b) => set({ body: b })}
                    suggestions={suggestions}
                    placeholder={'{\n  "phone": "{{ contact.phone }}",\n  "items": {{ trigger.body.items }}\n}'}
                  />
                </Field>
              )}
              {cfg.body_type === 'raw' && (
                <Field label={t('form.body')}>
                  <ExprTextarea mono rows={6} value={cfg.body ?? ''} onChange={(b) => set({ body: b })} suggestions={suggestions} />
                </Field>
              )}
              {cfg.body_type === 'form' && (
                <Field label={t('form.body')}>
                  <KeyValueList rows={cfg.form ?? []} onChange={(form) => set({ form })} suggestions={suggestions} keyPlaceholder="field" addLabel={t('form.addField')} />
                </Field>
              )}
            </>
          )}
          <Field label={t('form.timeout')}>
            <Input type="number" min={1} max={30} value={Number(cfg.timeout_s ?? 15)} onChange={(e) => set({ timeout_s: Number(e.target.value) })} />
          </Field>
          <p className="text-xs text-muted-foreground">{t('form.httpOutputHelp', { id: node.id })}</p>
        </>
      );
      break;
    }
    case 'code':
      body = (
        <>
          <Field label={t('form.code')}>
            <Textarea
              rows={14}
              value={String(c.code ?? '')}
              onChange={(e) => set({ code: e.target.value })}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
          <p className="text-xs text-muted-foreground">{t('form.codeHelp', { id: node.id })}</p>
        </>
      );
      break;
    case 'send_template': {
      const cfg = c as NodeConfigs['send_template'];
      // Number of {{n}} placeholders the template's body needs (null = unknown).
      const placeholderCount = (name: string, language: string) => {
        const tpl = lists.templates.find((x) => x.name === name && x.language === language);
        if (tpl?.body_text == null) return null;
        return Math.max(0, ...[...tpl.body_text.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      };
      const required = cfg.template_name ? placeholderCount(cfg.template_name, cfg.language ?? '') : null;
      const params = required === null
        ? cfg.params ?? []
        : Array.from({ length: required }, (_, i) => cfg.params?.[i] ?? '');
      const fieldOptions = suggestions.filter((s) => s.group === 'contact');
      body = (
        <>
          <Field label={t('form.template')}>
            <select
              className={selectClass}
              value={`${cfg.template_name}|${cfg.language ?? ''}`}
              onChange={(e) => {
                const [name, language] = e.target.value.split('|');
                const n = name ? placeholderCount(name, language) : null;
                set({
                  template_name: name,
                  language,
                  ...(n !== null && { params: Array.from({ length: n }, (_, i) => cfg.params?.[i] ?? '') }),
                });
              }}
            >
              <option value="|">{t('form.chooseTemplate')}</option>
              {lists.templates.map((tpl) => (
                <option key={`${tpl.name}|${tpl.language}`} value={`${tpl.name}|${tpl.language}`}>
                  {tpl.name} ({tpl.language})
                </option>
              ))}
            </select>
          </Field>
          <div className="space-y-2">
            <Label>{t('form.params')}</Label>
            {params.map((p, i) => {
              const setParam = (v: string) => set({ params: params.map((x, j) => (j === i ? v : x)) });
              const field = fieldOptions.find((s) => p === `{{ ${s.path} }}`);
              return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-10 shrink-0 font-mono text-xs text-muted-foreground">{`{{${i + 1}}}`}</span>
                    <select
                      className={`${selectClass} min-w-0 flex-1`}
                      value={field ? p : ''}
                      onChange={(e) => setParam(e.target.value)}
                    >
                      <option value="">{t('form.customValue')}</option>
                      {fieldOptions.map((s) => (
                        <option key={s.path} value={`{{ ${s.path} }}`}>
                          {s.hint ?? s.path}
                        </option>
                      ))}
                    </select>
                    {required === null && (
                      <Button type="button" variant="ghost" size="icon" className="h-8 w-7" onClick={() => set({ params: params.filter((_, j) => j !== i) })} aria-label="Remove">
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                  {!field && (
                    <ExprInput className="ml-[46px] min-w-0" value={p} onChange={setParam} suggestions={suggestions} />
                  )}
                </div>
              );
            })}
            {required === null && (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ params: [...params, ''] })}>
                <Plus className="h-3.5 w-3.5" />
                {t('form.addParam')}
              </Button>
            )}
            <p className="text-xs text-muted-foreground">{t('form.templateParamsHelp')}</p>
          </div>
          <Field label={t('form.retryUntil')} help={t('form.retryUntilHelp')}>
            <ExprInput value={String(cfg.retry_until ?? '')} onChange={(retry_until) => set({ retry_until })} suggestions={suggestions} />
          </Field>
        </>
      );
      break;
    }
    case 'send_text':
      body = (
        <Field label={t('form.message')} help={t('form.textHelp2')}>
          <ExprTextarea rows={6} value={String(c.text ?? '')} onChange={(text) => set({ text })} suggestions={suggestions} />
        </Field>
      );
      break;
    case 'send_media': {
      const cfg = c as NodeConfigs['send_media'];
      body = (
        <>
          <Field label={t('form.mediaType')}>
            <select className={selectClass} value={cfg.media_type} onChange={(e) => set({ media_type: e.target.value })}>
              {(['image', 'video', 'document'] as const).map((m) => (
                <option key={m} value={m}>
                  {t(`media.${m}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('form.mediaUrl')} help={t('form.mediaUrlHelp')}>
            <ExprInput value={cfg.url ?? ''} onChange={(url) => set({ url })} suggestions={suggestions} placeholder="https://…/catalog.pdf" />
          </Field>
          <Field label={t('form.caption')}>
            <ExprTextarea rows={3} value={cfg.caption ?? ''} onChange={(caption) => set({ caption })} suggestions={suggestions} />
          </Field>
          {cfg.media_type === 'document' && (
            <Field label={t('form.filename')}>
              <ExprInput value={cfg.filename ?? ''} onChange={(filename) => set({ filename })} suggestions={suggestions} placeholder="invoice.pdf" />
            </Field>
          )}
          <p className="text-xs text-muted-foreground">{t('form.windowHelp')}</p>
        </>
      );
      break;
    }
    case 'send_buttons': {
      const cfg = c as NodeConfigs['send_buttons'];
      const buttons = cfg.buttons ?? [];
      body = (
        <>
          <Field label={t('form.header')}>
            <ExprInput value={cfg.header ?? ''} onChange={(header) => set({ header })} suggestions={suggestions} />
          </Field>
          <Field label={t('form.message')}>
            <ExprTextarea rows={4} value={cfg.text ?? ''} onChange={(text) => set({ text })} suggestions={suggestions} />
          </Field>
          <Field label={t('form.footer')}>
            <ExprInput value={cfg.footer ?? ''} onChange={(footer) => set({ footer })} suggestions={suggestions} />
          </Field>
          <div className="space-y-2">
            <Label>{t('form.buttons')}</Label>
            {buttons.map((b, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <ExprInput
                  className="min-w-0 flex-1"
                  value={b.title}
                  onChange={(title) => set({ buttons: buttons.map((x, j) => (j === i ? { title } : x)) })}
                  suggestions={suggestions}
                  placeholder={t('form.buttonTitle')}
                />
                <Button type="button" variant="ghost" size="icon" className="h-8 w-7" onClick={() => set({ buttons: buttons.filter((_, j) => j !== i) })} aria-label="Remove">
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {buttons.length < 3 && (
              <Button type="button" variant="outline" size="sm" onClick={() => set({ buttons: [...buttons, { title: '' }] })}>
                <Plus className="h-3.5 w-3.5" />
                {t('form.addButton')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('form.buttonsHelp')}</p>
        </>
      );
      break;
    }
    case 'add_tag':
    case 'remove_tag':
      body = <Field label={t('form.tag')}>{tagSelect(c.tag_id)}</Field>;
      break;
    case 'update_contact': {
      const cfg = c as NodeConfigs['update_contact'];
      body = (
        <Field label={t('form.fieldsToUpdate')}>
          <KeyValueList
            rows={cfg.fields ?? []}
            onChange={(fields) => set({ fields })}
            suggestions={suggestions}
            addLabel={t('form.addField')}
            max={10}
            renderKey={(row, setKey) => (
              <select className={selectClass} value={row.key} onChange={(e) => setKey(e.target.value)}>
                <option value="">{t('form.chooseField')}</option>
                {CONTACT_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {t(`contactField.${f}`)}
                  </option>
                ))}
                {lists.customFields.map((f) => (
                  <option key={f.id} value={`custom:${f.id}`}>
                    {f.name}
                  </option>
                ))}
              </select>
            )}
          />
        </Field>
      );
      break;
    }
    case 'conversation': {
      const cfg = c as NodeConfigs['conversation'];
      body = (
        <>
          <Field label={t('form.action')}>
            <select className={selectClass} value={cfg.action} onChange={(e) => set({ action: e.target.value })}>
              {(['assign', 'close', 'reopen'] as const).map((a) => (
                <option key={a} value={a}>
                  {t(`conversationAction.${a}`)}
                </option>
              ))}
            </select>
          </Field>
          {cfg.action === 'assign' && (
            <Field label={t('form.teamMember')}>
              <select className={selectClass} value={cfg.user_id ?? ''} onChange={(e) => set({ user_id: e.target.value })}>
                <option value="">{t('summary.chooseMember')}</option>
                {lists.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      );
      break;
    }
    case 'create_deal': {
      const cfg = c as NodeConfigs['create_deal'];
      body = (
        <>
          <Field label={t('form.stage')}>
            <select
              className={selectClass}
              value={cfg.stage_id}
              onChange={(e) => {
                const st = lists.stages.find((s) => s.id === e.target.value);
                set({ stage_id: st?.id ?? '', pipeline_id: st?.pipeline_id ?? '' });
              }}
            >
              <option value="">{t('form.chooseStage')}</option>
              {lists.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.pipeline_name} → {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('form.dealTitle')}>
            <ExprInput value={cfg.title} onChange={(title) => set({ title })} suggestions={suggestions} />
          </Field>
          <Field label={t('form.dealValue')}>
            <Input type="number" min={0} value={Number(cfg.value ?? 0)} onChange={(e) => set({ value: Number(e.target.value) })} />
          </Field>
        </>
      );
      break;
    }
    case 'end':
      body = <p className="text-sm text-muted-foreground">{t('form.endHelp')}</p>;
      break;
  }

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader>
          <div className="flex items-center gap-2 pr-8">
            <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border', NODE_ACCENT[node.type])}>
              <Icon className="size-4" />
            </span>
            <SheetTitle className="min-w-0 flex-1">
              <input
                value={node.label ?? ''}
                onChange={(e) => onChange({ ...node, label: e.target.value.slice(0, 60) || undefined })}
                placeholder={t(`node.${node.type}`)}
                aria-label={t('form.stepName')}
                className="w-full bg-transparent text-base font-semibold outline-none placeholder:text-foreground"
              />
            </SheetTitle>
          </div>
          <SheetDescription>{t(`nodeHelp.${node.type}`)}</SheetDescription>
          <p className="text-[11px] text-muted-foreground">
            {t('form.stepId')} <code className="rounded bg-muted px-1">{node.id}</code>
          </p>
        </SheetHeader>

        <div className="space-y-4 px-4">
          {body}

          {nodeIssues.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              {nodeIssues.map((i) => (
                <li key={i.message}>• {i.message}</li>
              ))}
            </ul>
          )}

          {TESTABLE.has(node.type) && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{t('test.title')}</p>
                  <p className="text-xs text-muted-foreground">{t('test.help')}</p>
                </div>
                <Button type="button" size="sm" variant="secondary" onClick={runTest} disabled={testing}>
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                  {t('test.run')}
                </Button>
              </div>
              {result && (
                <div className="space-y-1.5 text-xs">
                  <div className="flex flex-wrap gap-2">
                    {result.slot && (
                      <span className="rounded-full border border-border px-2 py-0.5">
                        {t('test.leaves')} <b>{result.slot}</b>
                      </span>
                    )}
                    {result.dryRun && <span className="rounded-full border border-border px-2 py-0.5">{t('test.dryRun')}</span>}
                    <span className="text-muted-foreground">{result.run_id ? t('test.usingRun') : t('test.noRun')}</span>
                  </div>
                  {result.error && <p className="text-destructive">{result.error}</p>}
                  {result.output !== undefined && result.output !== null && (
                    <pre className="max-h-72 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
                      {JSON.stringify(result.output, null, 2)}
                    </pre>
                  )}
                  {result.logs && result.logs.length > 0 && (
                    <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
                      {result.logs.join('\n')}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <SheetFooter>
          {node.type !== 'trigger' && (
            <Button variant="outline" className="text-destructive" onClick={() => onDelete(node.id)}>
              <Trash2 className="h-4 w-4" />
              {t('form.deleteStep')}
            </Button>
          )}
          <Button onClick={onClose}>{t('form.done')}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
