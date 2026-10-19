'use client';

import { Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
  TRIGGER_TYPES,
  type ConditionKind,
  type DurationUnit,
  type JourneyNode,
  type NodeConfigs,
} from '@/lib/journeys/graph';
import type { GraphIssue } from '@/lib/journeys/graph';

export interface LookupLists {
  templates: { name: string; language: string }[];
  tags: { id: string; name: string }[];
  stages: { id: string; name: string; pipeline_id: string; pipeline_name: string }[];
}

const selectClass =
  'h-9 w-full rounded-lg border border-border bg-background px-2.5 text-sm text-foreground';

export function NodeConfigSheet({
  node,
  lists,
  issues,
  onChange,
  onDelete,
  onClose,
}: {
  node: JourneyNode | null;
  lists: LookupLists;
  issues: GraphIssue[];
  onChange: (node: JourneyNode) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations('Journeys');
  if (!node) return null;

  const set = (patch: Record<string, unknown>) =>
    onChange({ ...node, config: { ...(node.config as object), ...patch } as never });
  const c = node.config as Record<string, unknown>;
  const nodeIssues = issues.filter((i) => i.nodeId === node.id);

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
      const cfg = c as NodeConfigs['trigger'];
      body = (
        <>
          <div className="space-y-1.5">
            <Label>{t('form.startsWhen')}</Label>
            <select className={selectClass} value={cfg.trigger_type} onChange={(e) => set({ trigger_type: e.target.value })}>
              {TRIGGER_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {t(`trigger.${tt}`)}
                </option>
              ))}
            </select>
          </div>
          {cfg.trigger_type === 'tag_added' && (
            <div className="space-y-1.5">
              <Label>{t('form.tag')}</Label>
              {tagSelect(cfg.tag_id)}
            </div>
          )}
          {cfg.trigger_type === 'button_clicked' && (
            <div className="space-y-1.5">
              <Label>{t('form.buttonText')}</Label>
              <Input value={cfg.button_text ?? ''} onChange={(e) => set({ button_text: e.target.value })} placeholder={t('form.anyButton')} />
            </div>
          )}
          {cfg.trigger_type === 'manual' && <p className="text-xs text-muted-foreground">{t('form.manualHelp')}</p>}
        </>
      );
      break;
    }
    case 'wait':
      body = (
        <div className="space-y-1.5">
          <Label>{t('form.waitFor')}</Label>
          {duration()}
        </div>
      );
      break;
    case 'wait_for_reply':
      body = (
        <div className="space-y-1.5">
          <Label>{t('form.giveUpAfter')}</Label>
          {duration()}
          <p className="text-xs text-muted-foreground">{t('form.waitReplyHelp')}</p>
        </div>
      );
      break;
    case 'condition': {
      const cfg = c as NodeConfigs['condition'];
      body = (
        <>
          <div className="space-y-1.5">
            <Label>{t('form.check')}</Label>
            <select className={selectClass} value={cfg.kind} onChange={(e) => set({ kind: e.target.value as ConditionKind })}>
              {(['replied', 'clicked_button', 'has_tag', 'window_open'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`condition.${k}`)}
                </option>
              ))}
            </select>
          </div>
          {cfg.kind === 'has_tag' && (
            <div className="space-y-1.5">
              <Label>{t('form.tag')}</Label>
              {tagSelect(cfg.tag_id)}
            </div>
          )}
          {cfg.kind === 'clicked_button' && (
            <div className="space-y-1.5">
              <Label>{t('form.buttonText')}</Label>
              <Input value={cfg.button_text ?? ''} onChange={(e) => set({ button_text: e.target.value })} placeholder={t('form.anyButton')} />
            </div>
          )}
        </>
      );
      break;
    }
    case 'send_template': {
      const cfg = c as NodeConfigs['send_template'];
      body = (
        <>
          <div className="space-y-1.5">
            <Label>{t('form.template')}</Label>
            <select
              className={selectClass}
              value={`${cfg.template_name}|${cfg.language ?? ''}`}
              onChange={(e) => {
                const [name, language] = e.target.value.split('|');
                set({ template_name: name, language });
              }}
            >
              <option value="|">{t('form.chooseTemplate')}</option>
              {lists.templates.map((tpl) => (
                <option key={`${tpl.name}|${tpl.language}`} value={`${tpl.name}|${tpl.language}`}>
                  {tpl.name} ({tpl.language})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.params')}</Label>
            <Textarea
              rows={3}
              value={(cfg.params ?? []).join('\n')}
              onChange={(e) => set({ params: e.target.value.split('\n') })}
              placeholder={'{{name}}'}
            />
            <p className="text-xs text-muted-foreground">{t.raw('form.paramsHelp') as string}</p>
          </div>
        </>
      );
      break;
    }
    case 'send_text':
      body = (
        <div className="space-y-1.5">
          <Label>{t('form.message')}</Label>
          <Textarea rows={5} value={String(c.text ?? '')} onChange={(e) => set({ text: e.target.value })} />
          <p className="text-xs text-muted-foreground">{t.raw('form.textHelp') as string}</p>
        </div>
      );
      break;
    case 'add_tag':
    case 'remove_tag':
      body = (
        <div className="space-y-1.5">
          <Label>{t('form.tag')}</Label>
          {tagSelect(c.tag_id)}
        </div>
      );
      break;
    case 'create_deal': {
      const cfg = c as NodeConfigs['create_deal'];
      body = (
        <>
          <div className="space-y-1.5">
            <Label>{t('form.stage')}</Label>
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
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.dealTitle')}</Label>
            <Input value={cfg.title} onChange={(e) => set({ title: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('form.dealValue')}</Label>
            <Input type="number" min={0} value={Number(cfg.value ?? 0)} onChange={(e) => set({ value: Number(e.target.value) })} />
          </div>
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
      <SheetContent
        side="right"
        className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{t(`node.${node.type}`)}</SheetTitle>
          <SheetDescription>{t(`nodeHelp.${node.type}`)}</SheetDescription>
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
