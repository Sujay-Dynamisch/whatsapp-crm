'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  BATCH_SEND_ATTEMPTS,
  batchRetryDelayMs,
} from '@/lib/broadcast-retry';
import { normalizeKey } from '@/lib/contacts/dedupe';
import { getUnsubscribedContactIds } from '@/lib/contacts/unsubscribe';
import { Contact, MessageTemplate } from '@/types';

import type {
  SendTimeCardParams,
  SendTimeParams,
} from '@/lib/whatsapp/template-send-builder';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   */
  headerMediaUrl?: string;
  /**
   * When set, the broadcast is planned (row + pending recipients with
   * frozen params) and handed to the server-side scheduler instead of
   * being sent from this tab. See lib/broadcast-scheduling.
   */
  schedule?: {
    /** Wall-clock "YYYY-MM-DDTHH:mm" in `timezone`. */
    localDatetime: string;
    timezone: string;
  };
}

/**
 * The broadcast row and its recipients were saved, but the scheduling
 * call failed. Carries the id so the caller can take the user to the
 * broadcast, where scheduling can be retried — re-running the wizard
 * would plan a duplicate campaign.
 */
export class BroadcastScheduleError extends Error {
  readonly broadcastId: string;
  constructor(broadcastId: string, message: string) {
    super(message);
    this.name = 'BroadcastScheduleError';
    this.broadcastId = broadcastId;
  }
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
  processedCount: number;
  totalCount: number;
  sentCount: number;
  failedCount: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 *
 * Note this shape when touching `RATE_LIMITS.broadcast`: a campaign is
 * many calls to `/api/whatsapp/broadcast`, not one. A 1 000-recipient
 * send is ~100 calls over several minutes, and a bucket sized for
 * "one call per campaign" throttles most of it away (issue #472).
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

export function resolveSingleVariable(
  v: VariableMapping | undefined,
  contact: Contact,
  customValues?: Map<string, string>,
): string {
  if (!v || !v.value?.trim()) return '';
  if (v.type === 'static') return v.value;
  if (v.type === 'field') {
    const fieldMap: Record<string, string | undefined> = {
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      company: contact.company,
    };
    return fieldMap[v.value] ?? '';
  }
  if (v.type === 'custom_field') {
    return customValues?.get(v.value) ?? '';
  }
  return '';
}

export function resolveSendTimeParams(
  template: MessageTemplate,
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): SendTimeParams {
  const topBodyParams: string[] = [];
  if (template.body_text) {
    const matches = template.body_text.matchAll(/\{\{(\d+)\}\}/g);
    const seen = new Set<number>();
    for (const m of matches) {
      const num = Number(m[1]);
      if (Number.isFinite(num) && !seen.has(num)) {
        seen.add(num);
        const v = variables[`body_${num}`] ?? variables[`${num}`];
        topBodyParams.push(resolveSingleVariable(v, contact, customValues));
      }
    }
  }

  const carouselCards: SendTimeCardParams[] = [];
  if (template.carousel && Array.isArray(template.carousel)) {
    template.carousel.forEach((card, cardIdx) => {
      const cardBodyParams: string[] = [];
      if (card.body_text) {
        const matches = card.body_text.matchAll(/\{\{(\d+)\}\}/g);
        const seen = new Set<number>();
        for (const m of matches) {
          const num = Number(m[1]);
          if (Number.isFinite(num) && !seen.has(num)) {
            seen.add(num);
            const v =
              variables[`card_${cardIdx}_body_${num}`] ??
              variables[`card_${cardIdx}_${num}`] ??
              variables[`${num}`];
            cardBodyParams.push(resolveSingleVariable(v, contact, customValues));
          }
        }
      }

      const buttonParams: Record<number, string> = {};
      if (card.buttons) {
        card.buttons.forEach((btn, btnIdx) => {
          if ('url' in btn && btn.url) {
            const matches = btn.url.matchAll(/\{\{(\d+)\}\}/g);
            for (const m of matches) {
              const num = Number(m[1]);
              const v = variables[`card_${cardIdx}_btn_${btnIdx}_${num}`];
              if (v) {
                buttonParams[btnIdx] = resolveSingleVariable(v, contact, customValues);
                break;
              }
            }
          }
        });
      }

      carouselCards.push({
        cardIndex: cardIdx,
        body: cardBodyParams,
        buttonParams: Object.keys(buttonParams).length > 0 ? buttonParams : undefined,
      });
    });
  }

  return {
    body: topBodyParams.length > 0 ? topBodyParams : undefined,
    carouselCards: carouselCards.length > 0 ? carouselCards : undefined,
  };
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    return resolveSingleVariable(v, contact, customValues);
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST URL query params hang when .in(...) exceeds
  // ~2KB (around 50 UUIDs). Page in chunks of 50 to ensure fast, reliable requests.
  const PAGE = 50;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [processedCount, setProcessedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [sentCount, setSentCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        const PAGE = 50;
        for (let i = 0; i < uniqueContactIds.length; i += PAGE) {
          const chunk = uniqueContactIds.slice(i, i + PAGE);
          const { data, error } = await supabase
            .from('contacts')
            .select('*')
            .in('id', chunk);
          if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
          if (data) contacts.push(...data);
        }
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types).
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    // Always exclude contacts carrying the 'unsubscribe' tag
    if (accountId) {
      const unsubscribedIds = await getUnsubscribedContactIds(supabase, accountId);
      if (unsubscribedIds.size > 0) {
        contacts = contacts.filter((c) => !unsubscribedIds.has(c.id));
      }
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   *
   * Pre-existing implementation synthesized `csv-N` strings as
   * contact_id, which failed the UUID cast on insert — every CSV
   * broadcast silently created zero recipients.
   *
   * Matching is on the normalized number throughout, so it agrees with
   * the account-wide unique index rather than colliding with it.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }
    if (!accountId) {
      throw new Error('Your profile is not linked to an account.');
    }

    // De-duplicate within the CSV on the NORMALIZED number — the same
    // key the DB's UNIQUE (account_id, phone_normalized) index uses
    // (migration 022). Keyed on the raw string instead, "+1 555-0100"
    // and "15550100" survived as two rows and the insert below died on
    // a 23505, failing the whole broadcast.
    const uniqueByKey = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      const key = normalizeKey(row.phone);
      if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
    }
    const keys = [...uniqueByKey.keys()];

    // Single round-trip lookup of the contacts already in this ACCOUNT.
    // Scoping to `user_id` missed rows a teammate created on a shared
    // account, so those numbers looked new and their inserts collided
    // with the account-wide unique index.
    const { data: existing, error: lookupErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .in('phone_normalized', keys);
    if (lookupErr) {
      throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
    }

    const byKey = new Map<string, Contact>();
    for (const c of (existing ?? []) as Contact[]) {
      const key = normalizeKey(c.phone ?? '');
      if (key) byKey.set(key, c);
    }

    // Insert only missing contacts, in one batch per 200 rows (PostgREST
    // has a default payload cap — 200 keeps individual requests small).
    const missing = keys
      .filter((k) => !byKey.has(k))
      .map((k) => uniqueByKey.get(k)!)
      .map((row) => ({
        user_id: user.id,
        account_id: accountId,
        phone: row.phone,
        name: row.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        const key = normalizeKey(c.phone ?? '');
        if (key) byKey.set(key, c);
      }
    }

    // Preserve input order so analytics roughly matches the CSV order.
    return keys
      .map((k) => byKey.get(k))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    // Build the WHERE clause for the operator. PostgREST supports
    // eq/neq/ilike via the query builder — use ilike with wildcards
    // for "contains" so the match is case-insensitive.
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const contacts: Contact[] = [];
    const PAGE = 50;
    for (let i = 0; i < contactIds.length; i += PAGE) {
      const chunk = contactIds.slice(i, i + PAGE);
      const { data, error } = await supabase
        .from('contacts')
        .select('*')
        .in('id', chunk);
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      if (data) contacts.push(...data);
    }
    return contacts;
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);
    setProcessedCount(0);
    setTotalCount(0);
    setSentCount(0);
    setFailedCount(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }
      if (!accountId) {
        throw new Error('Your profile is not linked to an account.');
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }
      setTotalCount(contacts.length);

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          // Migration-043 columns are written only for scheduled sends, so
          // "Send now" keeps working on a database without that migration.
          ...(payload.schedule
            ? {
                template_id: payload.template.id ?? null,
                timezone: payload.schedule.timezone,
              }
            : {}),
          // A scheduled campaign stays 'scheduled' until the server
          // claims it at send time.
          status: payload.schedule ? 'scheduled' : 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      // Custom values are fetched BEFORE the insert so each row can
      // carry its resolved template params. Those params are what makes
      // the campaign resumable server-side (issue #472): the send loop
      // below runs in this browser tab, and if the tab goes away the
      // only record of what {{1}} should be for each contact is this
      // column. Resolving once here also means the resume sends exactly
      // what this pass would have.
      setProgress(20);
      const customValueIndex = await fetchCustomValueIndex(
        supabase,
        contacts.map((c) => c.id),
      );
      const paramsByContact = new Map(
        contacts.map((contact) => [
          contact.id,
          resolveVariables(
            payload.variables,
            contact,
            customValueIndex.get(contact.id),
          ),
        ]),
      );
      // Structured params (header media, carousel/button values) are
      // frozen too (migration 043) — a scheduled send runs entirely
      // server-side and has no other way to learn them.
      const frozenHeaderType = payload.template.header_type;
      const frozenHeaderMediaUrl = payload.headerMediaUrl?.trim();
      const freezeMessageParams = (contact: Contact): SendTimeParams => {
        const p = resolveSendTimeParams(
          payload.template,
          payload.variables,
          contact,
          customValueIndex.get(contact.id),
        );
        if (
          frozenHeaderMediaUrl &&
          (frozenHeaderType === 'image' ||
            frozenHeaderType === 'video' ||
            frozenHeaderType === 'document')
        ) {
          p.headerMediaUrl = frozenHeaderMediaUrl;
        }
        return p;
      };
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
        template_params: paramsByContact.get(contact.id) ?? [],
        ...(payload.schedule ? { message_params: freezeMessageParams(contact) } : {}),
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${Math.floor(i / INSERT_BATCH_SIZE) + 1}: ${recipientError.message}`,
          );
        }
        const insertProgress = 20 + Math.round(((i + batch.length) / recipientRows.length) * 10);
        setProgress(insertProgress);
      }

      // ── Scheduled: hand off to the server and stop here ───────────
      // Cloud Scheduler/Tasks deliver at the chosen time; nothing in
      // this tab needs to stay open.
      if (payload.schedule) {
        setProgress(60);
        const res = await fetch(`/api/whatsapp/broadcast/${broadcast.id}/schedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            local_datetime: payload.schedule.localDatetime,
            timezone: payload.schedule.timezone,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new BroadcastScheduleError(
            broadcast.id,
            data?.error || `Scheduling failed (HTTP ${res.status})`,
          );
        }
        setProgress(100);
        return broadcast.id;
      }

      // ── Step 4: Fetch recipients back (joined contact) ────────────
      setProgress(30);
      const { data: recipients, error: recipientsFetchError } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcast.id);

      if (recipientsFetchError || !recipients) {
        throw new Error('Failed to fetch broadcast recipients');
      }

      let totalFailed = 0;
      let totalSent = 0;
      const totalRecipients = recipients.length;
      setTotalCount(totalRecipients);

      // Media-header templates (image/video/document) require a media
      // URL on every send. Collected in the personalize step and applied
      // to all recipients; falls back to the template's stored URL on the
      // server when omitted.
      const headerType = payload.template.header_type;
      const isMediaHeader =
        headerType === 'image' ||
        headerType === 'video' ||
        headerType === 'document';
      const headerMediaUrl = payload.headerMediaUrl?.trim();

      for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
        const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

        const apiRecipients = batch
          .filter((r) => r.contact?.phone)
          .map((r) => {
            const contact = r.contact!;
            const customVals = customValueIndex.get(contact.id);
            const resolvedParams: SendTimeParams = resolveSendTimeParams(
              payload.template,
              payload.variables,
              contact,
              customVals,
            );
            if (isMediaHeader && headerMediaUrl) {
              resolvedParams.headerMediaUrl = headerMediaUrl;
            }
            return {
              phone: contact.phone as string,
              params: Array.isArray(r.template_params) ? r.template_params : [],
              messageParams: resolvedParams,
            };
          });

        if (apiRecipients.length === 0) continue;

        try {
          // Send the batch, waiting out a 429 rather than writing the
          // whole batch off as failed. Only 429 is replayed — see
          // batchRetryDelayMs for why nothing else can be.
          let data: { error?: string; results?: BroadcastApiResult[] } = {};
          for (let attempt = 1; ; attempt++) {
            const res = await fetch('/api/whatsapp/broadcast', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                recipients: apiRecipients,
                template_name: payload.template.name,
                template_language: payload.template.language ?? 'en_US',
              }),
            });

            data = await res.json();
            if (res.ok) break;

            const retryIn =
              attempt < BATCH_SEND_ATTEMPTS
                ? batchRetryDelayMs(res.status, res.headers.get('Retry-After'))
                : null;
            if (retryIn === null) {
              throw new Error(data.error || 'Broadcast API request failed');
            }
            await sleep(retryIn);
          }

          const resultsByPhone = new Map<string, BroadcastApiResult>();
          for (const r of (data.results ?? []) as BroadcastApiResult[]) {
            resultsByPhone.set(r.phone, r);
          }

          // Update recipient statuses in parallel for performance
          let batchSent = 0;
          let batchFailed = 0;
          const nowIso = new Date().toISOString();
          const recipientUpdates = batch.map((recipient) => {
            const phone = recipient.contact?.phone;
            const result = phone ? resultsByPhone.get(phone) : undefined;

            if (!result) {
              batchFailed++;
              return supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: 'No phone number on contact',
                })
                .eq('id', recipient.id);
            }

            if (result.status === 'sent') {
              batchSent++;
              return supabase
                .from('broadcast_recipients')
                .update({
                  status: 'sent',
                  sent_at: nowIso,
                  whatsapp_message_id: result.whatsapp_message_id ?? null,
                  error_message: null,
                })
                .eq('id', recipient.id);
            } else {
              batchFailed++;
              return supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: result.error ?? 'Unknown error',
                })
                .eq('id', recipient.id);
            }
          });

          await Promise.all(recipientUpdates);
          totalSent += batchSent;
          totalFailed += batchFailed;
          setSentCount(totalSent);
          setFailedCount(totalFailed);
          setProcessedCount(Math.min(i + batch.length, totalRecipients));
        } catch (err) {
          for (const recipient of batch) {
            totalFailed++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: err instanceof Error ? err.message : 'Unknown error',
              })
              .eq('id', recipient.id);
          }
          setFailedCount(totalFailed);
          setProcessedCount(Math.min(i + batch.length, totalRecipients));
        }

        const progressPct =
          30 + Math.round(((i + batch.length) / totalRecipients) * 60);
        setProgress(progressPct);

        if (i + SEND_BATCH_SIZE < recipients.length) {
          await sleep(SEND_BATCH_DELAY_MS);
        }
      }

      // ── Step 5: Finalize status ───────────────────────────────────
      // Aggregate counts are maintained by the DB trigger (migration
      // 003); we only flip the final status here.
      setProgress(95);
      const finalStatus = totalFailed === totalRecipients ? 'failed' : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcast.id);

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return {
    createAndSendBroadcast,
    isProcessing,
    progress,
    processedCount,
    totalCount,
    sentCount,
    failedCount,
  };
}
