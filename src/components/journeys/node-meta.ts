import {
  Braces,
  Clock,
  Code2,
  CornerDownRight,
  Flag,
  GitBranch,
  Globe,
  Handshake,
  Image as ImageIcon,
  LayoutTemplate,
  MessageSquareReply,
  MessageSquareText,
  MessagesSquare,
  Repeat,
  Split,
  SquareMousePointer,
  Tag,
  TagX,
  UserPen,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import type { JourneyNode, JourneyNodeType, NodeConfigs } from '@/lib/journeys/graph';

export const NODE_ICON: Record<JourneyNodeType, LucideIcon> = {
  trigger: Zap,
  wait: Clock,
  wait_for_reply: MessageSquareReply,
  condition: GitBranch,
  switch: Split,
  loop: Repeat,
  set_variable: Braces,
  http_request: Globe,
  code: Code2,
  send_template: LayoutTemplate,
  send_text: MessageSquareText,
  send_media: ImageIcon,
  send_buttons: SquareMousePointer,
  add_tag: Tag,
  remove_tag: TagX,
  update_contact: UserPen,
  conversation: MessagesSquare,
  create_deal: Handshake,
  end: Flag,
};

const ACCENT = {
  amber: 'border-amber-500/50 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  sky: 'border-sky-500/50 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  violet: 'border-violet-500/50 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  emerald: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  pink: 'border-pink-500/50 bg-pink-500/10 text-pink-600 dark:text-pink-400',
  orange: 'border-orange-500/50 bg-orange-500/10 text-orange-600 dark:text-orange-400',
  indigo: 'border-indigo-500/50 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
  slate: 'border-slate-500/40 bg-slate-500/10 text-muted-foreground',
};

/** Accent per step family (Tailwind classes, light + dark friendly). */
export const NODE_ACCENT: Record<JourneyNodeType, string> = {
  trigger: ACCENT.amber,
  wait: ACCENT.sky,
  wait_for_reply: ACCENT.sky,
  condition: ACCENT.violet,
  switch: ACCENT.violet,
  loop: ACCENT.violet,
  set_variable: ACCENT.indigo,
  http_request: ACCENT.indigo,
  code: ACCENT.indigo,
  send_template: ACCENT.emerald,
  send_text: ACCENT.emerald,
  send_media: ACCENT.emerald,
  send_buttons: ACCENT.emerald,
  add_tag: ACCENT.pink,
  remove_tag: ACCENT.pink,
  update_contact: ACCENT.pink,
  conversation: ACCENT.pink,
  create_deal: ACCENT.orange,
  end: ACCENT.slate,
};

/** "Add step" menu, grouped (the trigger is always present). */
export const STEP_GROUPS: { key: string; types: JourneyNodeType[] }[] = [
  { key: 'messages', types: ['send_template', 'send_text', 'send_media', 'send_buttons'] },
  { key: 'flow', types: ['wait', 'wait_for_reply', 'condition', 'switch', 'loop', 'end'] },
  { key: 'data', types: ['set_variable', 'http_request', 'code'] },
  { key: 'crm', types: ['add_tag', 'remove_tag', 'update_contact', 'conversation', 'create_deal'] },
];

/** Branch outputs drawn dashed (the "otherwise" paths). */
export const MUTED_SLOTS = new Set(['no', 'timeout', 'error', 'default', 'done']);

export const SLOT_ICON = CornerDownRight;

export interface Lookups {
  tags: Map<string, string>;
  stages: Map<string, string>;
  members?: Map<string, string>;
}

type T = (key: string, values?: Record<string, string | number>) => string;

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One-line summary under the step title. */
export function summarize(node: JourneyNode, t: T, lookups: Lookups): string {
  const c = node.config as Record<string, unknown>;
  const tag = (id: unknown) => lookups.tags.get(String(id)) ?? t('summary.chooseTag');
  switch (node.type) {
    case 'trigger': {
      const cfg = c as unknown as NodeConfigs['trigger'];
      if (cfg.trigger_type === 'tag_added') return t('trigger.tag_added_with', { tag: tag(cfg.tag_id) });
      if (cfg.trigger_type === 'button_clicked' && cfg.button_text)
        return t('trigger.button_clicked_with', { button: cfg.button_text });
      if (cfg.trigger_type === 'inbound_message' && cfg.keyword)
        return t('trigger.inbound_message_with', { keyword: cfg.keyword });
      if (cfg.trigger_type === 'schedule') {
        const audience = cfg.tag_id ? tag(cfg.tag_id) : t('summary.chooseTag');
        if (cfg.mode === 'interval') return t('summary.scheduleEvery', { every: cfg.every ?? 1, unit: t(`unit.${cfg.unit ?? 'hours'}`), tag: audience });
        return t('summary.scheduleAt', { time: cfg.time ?? '--:--', tag: audience });
      }
      return t(`trigger.${cfg.trigger_type}`);
    }
    case 'wait':
    case 'wait_for_reply': {
      const cfg = c as NodeConfigs['wait'];
      if (node.type === 'wait' && cfg.until?.trim()) return clip(t('summary.waitUntil', { until: cfg.until }));
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
      if (cfg.kind === 'expression') return clip(`${cfg.left ?? ''} ${t(`op.${cfg.op ?? 'equals'}`)} ${cfg.right ?? ''}`);
      return t(`condition.${cfg.kind}`);
    }
    case 'switch': {
      const cfg = c as NodeConfigs['switch'];
      return t('summary.switch', { value: clip(cfg.value || '…', 40), count: cfg.cases?.length ?? 0 });
    }
    case 'loop':
      return clip(String(c.items || t('summary.chooseList')));
    case 'set_variable': {
      const keys = ((c as NodeConfigs['set_variable']).assignments ?? []).map((a) => a.key).filter(Boolean);
      return keys.length ? clip(keys.map((k) => `vars.${k}`).join(', ')) : t('summary.addVariable');
    }
    case 'http_request': {
      const cfg = c as NodeConfigs['http_request'];
      return cfg.url ? clip(`${cfg.method} ${cfg.url}`) : t('summary.enterUrl');
    }
    case 'code': {
      const first = String(c.code ?? '')
        .split('\n')
        .find((l) => l.trim() && !l.trim().startsWith('//'));
      return clip(first?.trim() || t('summary.writeCode'));
    }
    case 'send_template':
      return String(c.template_name || t('summary.chooseTemplate'));
    case 'send_text': {
      const text = String(c.text ?? '').trim();
      return text ? clip(text) : t('summary.writeMessage');
    }
    case 'send_media': {
      const cfg = c as NodeConfigs['send_media'];
      return cfg.url ? `${t(`media.${cfg.media_type}`)} · ${clip(cfg.url, 40)}` : t('summary.enterUrl');
    }
    case 'send_buttons': {
      const cfg = c as NodeConfigs['send_buttons'];
      const titles = (cfg.buttons ?? []).map((b) => b.title).filter(Boolean);
      return titles.length ? clip(titles.map((x) => `[${x}]`).join(' ')) : t('summary.writeMessage');
    }
    case 'add_tag':
    case 'remove_tag':
      return tag(c.tag_id);
    case 'update_contact': {
      const keys = ((c as NodeConfigs['update_contact']).fields ?? []).map((f) => f.key.replace(/^custom:.*/, t('form.customField')));
      return keys.length ? clip(keys.join(', ')) : t('summary.chooseField');
    }
    case 'conversation': {
      const cfg = c as NodeConfigs['conversation'];
      if (cfg.action === 'assign') {
        return t('summary.assignTo', { name: (cfg.user_id && lookups.members?.get(cfg.user_id)) || t('summary.chooseMember') });
      }
      return t(`conversationAction.${cfg.action}`);
    }
    case 'create_deal':
      return lookups.stages.get(String(c.stage_id)) ?? t('summary.chooseStage');
    case 'end':
      return t('summary.end');
  }
}
