// The household's Haiku calls: one client, every call metered, and a monthly cap so a self-hoster
// is never surprised by the bill.
import Anthropic from '@anthropic-ai/sdk';
import { and, gte, sql } from 'drizzle-orm';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { aiUsage } from '../db/schema.ts';

// Haiku 5.5 per million tokens, for prompts of 100K tokens or fewer (Almanac's are far smaller).
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

export type Effort = 'low' | 'medium' | 'high';

/** Why an AI feature can't run right now; the app falls back to doing things as typed. */
export class AiUnavailable extends Error {}

export interface Ai {
  model: string;
  effort: Effort;
  monthlyCapUsd: number;
  available: boolean;
  client: Anthropic | null;
}

export function createAi(config: Config): Ai {
  const { apiKey, model, effort, monthlyCapUsd } = config.ai;
  return {
    model,
    effort,
    monthlyCapUsd,
    available: Boolean(apiKey),
    // Smart add waits on this call, so fail fast and fall back rather than hang.
    client: apiKey ? new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 }) : null,
  };
}

/** The start of this calendar month in the household's timezone. */
function monthStart(timezone: string) {
  const now = Temporal.Now.zonedDateTimeISO(timezone);
  return new Date(now.with({ day: 1 }).startOfDay().epochMilliseconds);
}

export function monthSpendUsd(db: Db, timezone: string) {
  const [row] = db
    .select({ micros: sql<number>`coalesce(sum(${aiUsage.costMicros}), 0)` })
    .from(aiUsage)
    .where(and(gte(aiUsage.createdAt, monthStart(timezone))))
    .all();
  return (row?.micros ?? 0) / 1_000_000;
}

export function costMicros(model: string, usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }) {
  const price = PRICES[model] ?? PRICES['claude-haiku-5-5']!;
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  return Math.round(input * price.input + usage.output_tokens * price.output);
}

export function recordUsage(
  db: Db,
  entry: { memberId: string | null; feature: string; model: string; effort: string; usage?: Parameters<typeof costMicros>[1]; durationMs: number; ok: boolean },
) {
  db.insert(aiUsage)
    .values({
      memberId: entry.memberId,
      feature: entry.feature,
      model: entry.model,
      effort: entry.effort,
      inputTokens: entry.usage?.input_tokens ?? 0,
      outputTokens: entry.usage?.output_tokens ?? 0,
      costMicros: entry.usage ? costMicros(entry.model, entry.usage) : 0,
      durationMs: entry.durationMs,
      ok: entry.ok,
    })
    .run();
}

/** Throws AiUnavailable when there's no key or this month's spending has reached the cap. */
export function requireAi(ai: Ai, db: Db, timezone: string): Anthropic {
  if (!ai.client) throw new AiUnavailable('No Anthropic API key is set on the server.');
  if (monthSpendUsd(db, timezone) >= ai.monthlyCapUsd) {
    throw new AiUnavailable(`This month's AI budget ($${ai.monthlyCapUsd}) is used up.`);
  }
  return ai.client;
}
