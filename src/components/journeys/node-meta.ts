import {
  Clock,
  CornerDownRight,
  Flag,
  GitBranch,
  Handshake,
  LayoutTemplate,
  MessageSquareReply,
  MessageSquareText,
  Tag,
  TagX,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { JourneyNode, JourneyNodeType, NodeConfigs } from '@/lib/journeys/graph';

export const NODE_ICON: Record<JourneyNodeType, LucideIcon> = {
  trigger: Zap,
  wait: Clock,
  wait_for_reply: MessageSquareReply,
  condition: GitBranch,
  send_template: LayoutTemplate,
  send_text: MessageSquareText,
  add_tag: Tag,
  remove_tag: TagX,
  create_deal: Handshake,
  end: Flag,
};

/** Accent per step family (Tailwind classes, light + dark friendly). */
export const NODE_ACCENT: Record<JourneyNodeType, string> = {
  trigger: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  wait: 'border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  wait_for_reply: 'border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  condition: 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  send_template: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  send_text: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  add_tag: 'border-pink-500/50 bg-pink-500/10 text-pink-600 dark:text-pink-400',
  remove_tag: 'border-pink-500/50 bg-pink-500/10 text-pink-600 dark:text-pink-400',
  create_deal: 'border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  end: 'border-slate-500/40 bg-slate-500/10 text-muted-foreground',
};

/** Steps offered in the "Add step" menu (the trigger is always present). */
export const ADDABLE: JourneyNodeType[] = [
  'wait',
  'wait_for_reply',
  'condition',
  'send_template',
  'send_text',
  'add_tag',
  'remove_tag',
  'create_deal',
  'end',
];

export const SLOT_ICON = CornerDownRight;

export interface Lookups {
  tags: Map<string, string>;
  stages: Map<string, string>;
}

type T = (key: string, values?: Record<string, string | number>) => string;

/** One-line summary under the step title. */
export function summarize(node: JourneyNode, t: T, lookups: Lookups): string {
  const c = node.config as Record<string, unknown>;
  const tag = (id: unknown) => lookups.tags.get(String(id)) ?? t('summary.chooseTag');
  switch (node.type) {
    case 'trigger': {
      const cfg = c as NodeConfigs['trigger'];
      if (cfg.trigger_type === 'tag_added') return t('trigger.tag_added_with', { tag: tag(cfg.tag_id) });
      if (cfg.trigger_type === 'button_clicked' && cfg.button_text)
        return t('trigger.button_clicked_with', { button: cfg.button_text });
      return t(`trigger.${cfg.trigger_type}`);
    }
    case 'wait':
    case 'wait_for_reply': {
      const cfg = c as NodeConfigs['wait'];
      return t(node.type === 'wait' ? 'summary.wait' : 'summary.waitReply', {
        amount: cfg.amount,
        unit: t(`unit.${cfg.unit}`),
      });
    }
    case 'condition': {
      const cfg = c as NodeConfigs['condition'];
      if (cfg.kind === 'has_tag') return t('summary.hasTag', { tag: tag(cfg.tag_id) });
      if (cfg.kind === 'clicked_button')
        return cfg.button_text ? t('summary.clicked', { button: cfg.button_text }) : t('summary.clickedAny');
      return t(`condition.${cfg.kind}`);
    }
    case 'send_template':
      return String(c.template_name || t('summary.chooseTemplate'));
    case 'send_text': {
      const text = String(c.text ?? '').trim();
      return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : t('summary.writeMessage');
    }
    case 'add_tag':
    case 'remove_tag':
      return tag(c.tag_id);
    case 'create_deal':
      return lookups.stages.get(String(c.stage_id)) ?? t('summary.chooseStage');
    case 'end':
      return t('summary.end');
  }
}
