import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { AI_PROVIDER_DEFAULT_MODEL } from '../defaults';
import { AI_PROVIDER_INFO, AI_PROVIDERS, isAiProvider } from './registry';

describe('AI provider registry', () => {
  it('describes every provider completely', () => {
    for (const p of AI_PROVIDERS) {
      const info = AI_PROVIDER_INFO[p];
      expect(info.label).toBeTruthy();
      expect(info.defaultModel).toBeTruthy();
      expect(info.modelHints).toContain(info.defaultModel);
      expect(info.keyPlaceholder).toBeTruthy();
      expect(info.keyUrl).toMatch(/^https:\/\//);
      expect(info.note).toBeTruthy();
      if (info.adapter === 'openai_compatible') {
        expect(info.baseUrl).toMatch(/^https:\/\/[^/]+/);
        expect(info.baseUrl).not.toMatch(/\/$/);
      } else {
        expect(info.baseUrl).toBeUndefined();
      }
    }
  });

  it('offers the free-tier options users asked for', () => {
    const free = AI_PROVIDERS.filter((p) => AI_PROVIDER_INFO[p].freeTier);
    expect(free).toEqual(expect.arrayContaining(['gemini', 'groq', 'openrouter', 'mistral', 'cerebras']));
    expect(AI_PROVIDERS).toContain('xai'); // Grok
  });

  it('keeps the original two providers on their native adapters', () => {
    expect(AI_PROVIDER_INFO.openai.adapter).toBe('openai');
    expect(AI_PROVIDER_INFO.anthropic.adapter).toBe('anthropic');
  });

  it('derives the default-model map from the registry', () => {
    for (const p of AI_PROVIDERS) {
      expect(AI_PROVIDER_DEFAULT_MODEL[p]).toBe(AI_PROVIDER_INFO[p].defaultModel);
    }
  });

  it('isAiProvider accepts known ids only', () => {
    expect(isAiProvider('gemini')).toBe(true);
    expect(isAiProvider('Gemini')).toBe(false);
    expect(isAiProvider('llama')).toBe(false);
    expect(isAiProvider(undefined)).toBe(false);
  });

  it('matches the provider list migration 047 allows in the database', () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/047_ai_providers.sql'),
      'utf8'
    );
    const list = /CHECK \(provider IN \(([\s\S]*?)\)\)/.exec(sql)![1];
    const inSql = [...list.matchAll(/''([a-z]+)''/g)].map((m) => m[1]);
    expect([...inSql].sort()).toEqual([...AI_PROVIDERS].sort());
  });
});
