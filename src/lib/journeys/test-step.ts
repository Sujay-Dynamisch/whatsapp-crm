// ============================================================
// "Test step" in the editor (migration 054): run one step against a
// scope taken from an earlier run (or sample data) and show what it
// would produce — n8n's "execute node". Data steps (HTTP, code,
// variables, switch, condition, loop) really execute; message steps
// only render their text; nothing is sent and nothing is written.
// ============================================================

import { compare, evaluateValue, renderTemplate, type ExprScope } from './expressions';
import { MAX_LOOP_ITEMS, type JourneyNode, type NodeConfigs } from './graph';
import { HttpStepError, runHttpRequest } from './http';

export interface StepPreview {
  /** Output the step would hand to later steps. */
  output: unknown;
  /** Which connection it would leave by, when that is known. */
  slot?: string;
  error?: string;
  logs?: string[];
  /** True when the step was only rendered, not executed. */
  dryRun?: boolean;
}

export async function previewStep(node: JourneyNode, scope: ExprScope): Promise<StepPreview> {
  switch (node.type) {
    case 'trigger':
      return { output: scope.trigger, slot: 'next' };

    case 'set_variable': {
      const cfg = node.config as NodeConfigs['set_variable'];
      const out: Record<string, unknown> = {};
      const s = { ...scope };
      for (const a of cfg.assignments ?? []) {
        if (!a.key) continue;
        out[a.key] = evaluateValue(a.value ?? '', s);
        s.vars = { ...s.vars, [a.key]: out[a.key] };
      }
      return { output: out, slot: 'next' };
    }

    case 'switch': {
      const cfg = node.config as NodeConfigs['switch'];
      const value = evaluateValue(cfg.value, scope);
      const i = (cfg.cases ?? []).findIndex((k) => compare(k.op, value, evaluateValue(k.value ?? '', scope)));
      return { output: { value, matched: i >= 0 ? i : null }, slot: i >= 0 ? `case_${i}` : 'default' };
    }

    case 'condition': {
      const cfg = node.config as NodeConfigs['condition'];
      if (cfg.kind !== 'expression') {
        return { output: null, dryRun: true, error: 'This check reads live data — it is evaluated when the journey runs' };
      }
      const left = evaluateValue(cfg.left ?? '', scope);
      const right = evaluateValue(cfg.right ?? '', scope);
      const result = compare(cfg.op ?? 'equals', left, right);
      return { output: { left, right, result }, slot: result ? 'yes' : 'no' };
    }

    case 'loop': {
      const cfg = node.config as NodeConfigs['loop'];
      const raw = evaluateValue(cfg.items, scope);
      const list = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === '' ? [] : [raw];
      const items = list.slice(0, Math.min(MAX_LOOP_ITEMS, Number(cfg.max) || MAX_LOOP_ITEMS));
      return { output: { total: items.length, first: items[0] ?? null }, slot: items.length ? 'each' : 'done' };
    }

    case 'http_request': {
      try {
        const output = await runHttpRequest(node.config as NodeConfigs['http_request'], scope);
        return { output, slot: 'success' };
      } catch (err) {
        if (err instanceof HttpStepError) return { output: err.output, slot: 'error', error: err.message };
        throw err;
      }
    }

    case 'code': {
      const { runUserCode } = await import('./sandbox');
      try {
        const { result, logs } = await runUserCode((node.config as NodeConfigs['code']).code, { ...scope });
        return { output: result, logs, slot: 'success' };
      } catch (err) {
        return { output: null, slot: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    }

    case 'send_text':
      return { output: { text: renderTemplate((node.config as NodeConfigs['send_text']).text, scope) }, dryRun: true, slot: 'next' };

    case 'send_template': {
      const cfg = node.config as NodeConfigs['send_template'];
      return {
        output: { template: cfg.template_name, params: (cfg.params ?? []).map((p) => renderTemplate(p, scope)) },
        dryRun: true,
        slot: 'next',
      };
    }

    case 'send_media': {
      const cfg = node.config as NodeConfigs['send_media'];
      return {
        output: { media_type: cfg.media_type, url: renderTemplate(cfg.url, scope), caption: renderTemplate(cfg.caption ?? '', scope) },
        dryRun: true,
        slot: 'next',
      };
    }

    case 'send_buttons': {
      const cfg = node.config as NodeConfigs['send_buttons'];
      return {
        output: {
          text: renderTemplate(cfg.text, scope),
          buttons: (cfg.buttons ?? []).map((b) => renderTemplate(b.title, scope).slice(0, 20)),
        },
        dryRun: true,
        slot: 'next',
      };
    }

    case 'update_contact': {
      const cfg = node.config as NodeConfigs['update_contact'];
      return {
        output: Object.fromEntries((cfg.fields ?? []).map((f) => [f.key, renderTemplate(f.value ?? '', scope)])),
        dryRun: true,
        slot: 'next',
      };
    }

    case 'create_deal': {
      const cfg = node.config as NodeConfigs['create_deal'];
      return { output: { title: renderTemplate(cfg.title || 'Deal', scope), value: cfg.value ?? 0 }, dryRun: true, slot: 'next' };
    }

    default:
      return { output: null, dryRun: true, error: 'Nothing to test on this step — it runs when the journey runs' };
  }
}
