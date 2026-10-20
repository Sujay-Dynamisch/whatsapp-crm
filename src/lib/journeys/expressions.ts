// ============================================================
// Journey expressions (migration 054) — the `{{ … }}` placeholders in
// step fields, n8n-style but without eval:
//
//   {{ contact.name }}                  the enrolled contact
//   {{ trigger.body.order.id }}         what started the run (webhook
//                                       body/query, inbound text, …)
//   {{ nodes.n_ab12cd34.body.total }}   any earlier step's output
//   {{ vars.coupon }}                   set by "Set variable"
//   {{ item.name }} / {{ index }}       current loop item
//   {{ reply.text }}                    the customer's last reply
//   {{ now }}                           ISO timestamp
//   {{ name }} / {{ phone }}            legacy aliases (contact.*)
//
// A path may use dots and [0] / ["key"]. Filters follow a pipe:
//   {{ contact.name | default:"there" | upper }}
// Anything that needs real logic belongs in a Code step.
// ============================================================

import { UNARY_OPS, type CompareOp } from './graph';

export interface ExprScope {
  contact: Record<string, unknown>;
  trigger: Record<string, unknown>;
  nodes: Record<string, unknown>;
  vars: Record<string, unknown>;
  reply: Record<string, unknown> | null;
  item: unknown;
  index: number | null;
  now: string;
}

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const SINGLE = /^\{\{\s*([^{}]*?)\s*\}\}$/;

// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------

/** Split `a.b[0]["c d"]` into ['a', 'b', 0, 'c d']; null if malformed. */
export function parsePath(path: string): (string | number)[] | null {
  const out: (string | number)[] = [];
  const re = /\s*(?:(^|\.)\s*([A-Za-z_$][\w$-]*)|\[\s*(\d+)\s*\]|\[\s*(["'])((?:\\.|(?!\4).)*)\4\s*\])/y;
  let pos = 0;
  const s = path.trim();
  while (pos < s.length) {
    re.lastIndex = pos;
    const m = re.exec(s);
    if (!m || m.index !== pos) return null;
    if (m[2] !== undefined) {
      if (pos > 0 && m[1] !== '.') return null;
      out.push(m[2]);
    } else if (m[3] !== undefined) out.push(Number(m[3]));
    else out.push(m[5].replace(/\\(.)/g, '$1'));
    pos = re.lastIndex;
  }
  return out.length ? out : null;
}

function rootOf(scope: ExprScope, key: string): unknown {
  switch (key) {
    case 'contact':
    case 'trigger':
    case 'nodes':
    case 'vars':
    case 'reply':
    case 'item':
    case 'index':
    case 'now':
      return scope[key];
    // Legacy {{name}} / {{phone}} from the first journey version.
    case 'name':
    case 'phone':
    case 'email':
      return scope.contact?.[key];
    default:
      return undefined;
  }
}

export function resolvePath(scope: ExprScope, path: string): unknown {
  const parts = parsePath(path);
  if (!parts || typeof parts[0] !== 'string') return undefined;
  let cur: unknown = rootOf(scope, parts[0]);
  for (const p of parts.slice(1)) {
    if (cur === null || cur === undefined) return undefined;
    if (p === 'length' && (Array.isArray(cur) || typeof cur === 'string')) {
      cur = cur.length;
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    // Own properties only — no walking up to Object.prototype.
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string | number, unknown>)[p];
  }
  return cur;
}

// ------------------------------------------------------------------
// Filters
// ------------------------------------------------------------------

/** Split on `sep` outside quotes. */
function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === sep) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function parseArg(raw: string): unknown {
  const s = raw.trim();
  const q = s.match(/^(["'])((?:\\.|(?!\1).)*)\1$/);
  if (q) return q[2].replace(/\\(.)/g, '$1');
  if (s !== '' && Number.isFinite(Number(s))) return Number(s);
  if (s === 'true' || s === 'false') return s === 'true';
  return s;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function applyFilter(value: unknown, name: string, args: unknown[]): unknown {
  const str = () => stringify(value);
  switch (name) {
    case 'default':
      return isEmptyValue(value) ? args[0] ?? '' : value;
    case 'upper':
      return str().toUpperCase();
    case 'lower':
      return str().toLowerCase();
    case 'trim':
      return str().trim();
    case 'capitalize': {
      const s = str();
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    case 'json':
      return JSON.stringify(value ?? null);
    case 'length':
      return Array.isArray(value) || typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 0;
    case 'first':
      return Array.isArray(value) ? value[0] : typeof value === 'string' ? value.charAt(0) : value;
    case 'last':
      return Array.isArray(value) ? value[value.length - 1] : typeof value === 'string' ? value.slice(-1) : value;
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }
    case 'round': {
      const n = Number(value);
      const digits = Math.min(10, Math.max(0, Number(args[0] ?? 0) || 0));
      return Number.isFinite(n) ? Number(n.toFixed(digits)) : value;
    }
    case 'join':
      return Array.isArray(value) ? value.map(stringify).join(String(args[0] ?? ', ')) : str();
    case 'replace':
      return str().split(String(args[0] ?? '')).join(String(args[1] ?? ''));
    case 'urlencode':
      return encodeURIComponent(str());
    case 'truncate': {
      const s = str();
      const n = Math.max(1, Number(args[0] ?? 100) || 100);
      return s.length > n ? `${s.slice(0, n)}…` : s;
    }
    default:
      return value;
  }
}

/** Evaluate one expression body (`path | filter:arg | …`). */
export function evaluate(expr: string, scope: ExprScope): unknown {
  const [pathPart, ...filters] = splitOutsideQuotes(expr, '|');
  const head = pathPart.trim();
  // A bare literal is allowed, e.g. {{ "hi" | upper }}.
  let value: unknown = /^(["']).*\1$/.test(head) || /^-?\d+(\.\d+)?$/.test(head) ? parseArg(head) : resolvePath(scope, head);
  for (const f of filters) {
    const [name, ...rest] = splitOutsideQuotes(f, ':');
    const args = rest.length ? splitOutsideQuotes(rest.join(':'), ',').map(parseArg) : [];
    value = applyFilter(value, name.trim(), args);
  }
  return value;
}

export function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

/**
 * Replace every `{{ … }}` in `text`. `escape` post-processes each
 * inserted value — the HTTP step uses it to keep JSON bodies valid.
 */
export function renderTemplate(text: string, scope: ExprScope, escape?: (s: string) => string): string {
  if (!text) return '';
  return text.replace(PLACEHOLDER, (_m, expr: string) => {
    const s = stringify(evaluate(expr, scope));
    return escape ? escape(s) : s;
  });
}

/**
 * A field that is exactly one placeholder keeps the value's type
 * (`{{ nodes.x.body.items }}` stays an array); anything else renders
 * to a string.
 */
export function evaluateValue(text: string, scope: ExprScope): unknown {
  const m = String(text ?? '').trim().match(SINGLE);
  if (m) return evaluate(m[1], scope);
  return renderTemplate(String(text ?? ''), scope);
}

/** Escape a value for insertion inside a JSON string literal. */
export function jsonStringEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * Render a JSON body template. A placeholder inside a string literal
 * ("Hi {{ contact.name }}") is escaped into that string; one standing
 * alone as a value ({{ trigger.body.items }}) becomes JSON — numbers
 * stay numbers, text gets quoted, objects / arrays are embedded.
 */
export function renderJsonTemplate(text: string, scope: ExprScope): string {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('{{', i)) {
      const end = text.indexOf('}}', i + 2);
      if (end !== -1) {
        const value = evaluate(text.slice(i + 2, end).trim(), scope);
        out += inString ? jsonStringEscape(stringify(value)) : JSON.stringify(value ?? null);
        i = end + 2;
        continue;
      }
    }
    const ch = text[i];
    if (ch === '\\' && inString) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === '"') inString = !inString;
    out += ch;
    i++;
  }
  return out;
}

// ------------------------------------------------------------------
// Comparisons (expression conditions + switch cases)
// ------------------------------------------------------------------

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asTime(v: unknown): number | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** <0, 0, >0 — numbers, then ISO dates, then case-insensitive text. */
function order(a: unknown, b: unknown): number {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const ta = asTime(a);
  const tb = asTime(b);
  if (ta !== null && tb !== null) return ta - tb;
  return stringify(a).trim().toLowerCase().localeCompare(stringify(b).trim().toLowerCase());
}

const MAX_REGEX_PATTERN = 200;
const MAX_REGEX_INPUT = 2000;

export function compare(op: CompareOp, left: unknown, right: unknown): boolean {
  const l = stringify(left).trim().toLowerCase();
  const r = stringify(right).trim().toLowerCase();
  switch (op) {
    case 'equals': {
      const na = asNumber(left);
      const nb = asNumber(right);
      return na !== null && nb !== null ? na === nb : l === r;
    }
    case 'not_equals':
      return !compare('equals', left, right);
    case 'contains':
      return Array.isArray(left) ? left.some((x) => compare('equals', x, right)) : l.includes(r);
    case 'not_contains':
      return !compare('contains', left, right);
    case 'starts_with':
      return l.startsWith(r);
    case 'ends_with':
      return l.endsWith(r);
    case 'gt':
      return order(left, right) > 0;
    case 'gte':
      return order(left, right) >= 0;
    case 'lt':
      return order(left, right) < 0;
    case 'lte':
      return order(left, right) <= 0;
    case 'is_empty':
      return isEmptyValue(left);
    case 'not_empty':
      return !isEmptyValue(left);
    case 'regex': {
      const pattern = stringify(right);
      if (!pattern || pattern.length > MAX_REGEX_PATTERN) return false;
      try {
        return new RegExp(pattern, 'i').test(stringify(left).slice(0, MAX_REGEX_INPUT));
      } catch {
        return false;
      }
    }
  }
  return false;
}

export function isUnary(op: CompareOp): boolean {
  return UNARY_OPS.includes(op);
}

/** Empty scope — the editor's "test step" fills in what it knows. */
export function emptyScope(now = new Date()): ExprScope {
  return { contact: {}, trigger: {}, nodes: {}, vars: {}, reply: null, item: null, index: null, now: now.toISOString() };
}
