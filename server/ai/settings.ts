// Which AI model a copy of Amble uses, as Settings shows and changes it: on a device for itself, or
// on the household's server for everyone (server/settings.ts), through the same few calls.
import { z } from 'zod';
import { AI_PROVIDERS, aiModel, aiProvider, type AiProviderId } from '../../shared/ai.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DomainError } from '../domain/household.ts';
import { checkSetup, fromEnvironment, modelName, monthSpendUsd, type Ai } from './client.ts';

/** "localhost:11434" from "http://localhost:11434/v1". */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What Settings shows about the model in use. The key itself never leaves the copy that keeps it. */
export function aiView(ai: Ai, db: Db, config: Config, member: { role: string; smartAdd: boolean }) {
  const setup = ai.setup();
  const admin = member.role === 'admin';
  return {
    available: setup != null,
    smartAdd: setup != null && member.smartAdd,
    provider: setup?.provider ?? null,
    // A service the admin typed in goes by its address.
    providerName: !setup ? null : setup.provider === 'custom' ? hostOf(setup.baseUrl) : (aiProvider(setup.provider)?.name ?? setup.provider),
    model: setup?.model ?? null,
    modelName: setup ? modelName(setup) : null,
    effort: setup?.effort ?? null,
    source: setup?.source ?? null,
    // Whether the server's environment sets one too, which Remove in Settings goes back to.
    environment: fromEnvironment(config) != null,
    priced: setup?.prices != null,
    monthSpendUsd: Math.round(monthSpendUsd(db, config.timezone) * 100) / 100,
    monthlyCapUsd: setup?.monthlyCapUsd ?? config.ai.monthlyCapUsd,
    // What the admin needs to change it.
    settings:
      admin && setup && setup.source !== 'server'
        ? {
            provider: setup.provider,
            model: setup.model,
            baseUrl: setup.baseUrl,
            effort: setup.effort,
            monthlyCapUsd: setup.monthlyCapUsd,
            prices: setup.prices,
            keyEnding: setup.apiKey ? setup.apiKey.slice(-4) : null,
          }
        : null,
    keyUnreadable: admin && !setup && ai.keyState() === 'unreadable',
    // On a device that syncs with the household's server: the server's model, which this one
    // uses unless it has its own.
    server: (() => {
      const s = ai.server();
      return s ? { providerName: aiProvider(s.provider)?.name ?? s.provider, modelName: modelName(s) } : null;
    })(),
  };
}

export type AiView = ReturnType<typeof aiView>;

export const aiSettingsInput = z.object({
  provider: z.enum(AI_PROVIDERS.map((p) => p.id) as [AiProviderId, ...AiProviderId[]]),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(500).default(''),
  apiKey: z.string().trim().max(500).default(''),
  effort: z.enum(['default', 'low', 'medium', 'high']),
  monthlyCapUsd: z.number().min(0).max(10_000),
  prices: z.tuple([z.number().min(0).max(1000), z.number().min(0).max(1000)]).nullable().default(null),
  check: z.boolean().default(true),
});

/** An admin picks the model. It's tried first, unless they say to save it anyway. */
export async function saveAiSettings(ai: Ai, input: z.output<typeof aiSettingsInput>): Promise<{ ok: true; ms: number | null } | { ok: false; error: string }> {
  const preset = aiProvider(input.provider)!;
  const baseUrl = input.provider === 'custom' ? input.baseUrl.replace(/\/+$/, '') : preset.baseUrl;
  if (input.provider === 'custom' && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new DomainError('Add the address of its API, like http://localhost:11434/v1.');
  const current = ai.setup();
  // Keep the key already in use when it's for the same provider and none was typed.
  const apiKey = input.apiKey || (current?.provider === input.provider ? current.apiKey : '');
  if (!apiKey && input.provider !== 'custom') throw new DomainError(`Add an API key from ${preset.name}.`);
  const settings = {
    provider: input.provider,
    model: input.model,
    baseUrl,
    apiKey,
    effort: input.effort,
    monthlyCapUsd: input.monthlyCapUsd,
    prices: aiModel(input.provider, input.model)?.price ?? input.prices,
  };
  let ms: number | null = null;
  if (input.check) {
    const result = await checkSetup(ai, { ...settings, source: 'settings' });
    if (!result.ok) return { ok: false, error: result.error };
    ms = result.ms;
  }
  ai.save(settings);
  return { ok: true, ms };
}
