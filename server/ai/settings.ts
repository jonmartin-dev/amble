// Which AI model a copy of Amble uses, as Settings shows and changes it: on a device for itself, or
// on the household's server for everyone (server/settings.ts), through the same few calls.
import { z } from 'zod';
import { AI_PROVIDERS, aiModel, aiProvider, type AiProviderId } from '../../shared/ai.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { DomainError } from '../domain/household.ts';
import { checkSetup, fromEnvironment, modelName, spentAgainst, type Ai, type AiSetup } from './client.ts';

/** "localhost:11434" from "http://localhost:11434/v1". */
function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** What an admin needs to change a model, without its key. */
const editable = (setup: AiSetup) => ({
  provider: setup.provider,
  model: setup.model,
  baseUrl: setup.baseUrl,
  effort: setup.effort,
  monthlyCapUsd: setup.monthlyCapUsd,
  prices: setup.prices,
  keyEnding: setup.apiKey ? setup.apiKey.slice(-4) : null,
});

const providerName = (setup: Pick<AiSetup, 'provider' | 'baseUrl'>) =>
  // A service the admin typed in goes by its address.
  setup.provider === 'custom' ? hostOf(setup.baseUrl) : (aiProvider(setup.provider)?.name ?? setup.provider);

/** What Settings shows about the model in use. The key itself never leaves the copy that keeps it. */
export function aiView(ai: Ai, db: Db, config: Config, member: { role: string; smartAdd: boolean }) {
  const setup = ai.setup();
  const own = ai.own();
  const household = ai.household();
  const admin = member.role === 'admin';
  return {
    available: setup != null,
    smartAdd: setup != null && member.smartAdd,
    provider: setup?.provider ?? null,
    providerName: setup ? providerName(setup) : null,
    model: setup?.model ?? null,
    modelName: setup ? modelName(setup) : null,
    effort: setup?.effort ?? null,
    source: setup?.source ?? null,
    // Whether the server's environment sets one too, which Remove in Settings goes back to.
    environment: fromEnvironment(config) != null,
    priced: setup?.prices != null,
    // The household's model counts everyone's spending together.
    monthSpendUsd: setup ? Math.round(spentAgainst(setup, db, config.timezone) * 100) / 100 : 0,
    monthlyCapUsd: setup?.monthlyCapUsd ?? config.ai.monthlyCapUsd,
    // What the admin needs to change this copy's own.
    settings: admin && own ? editable(own) : null,
    keyUnreadable: admin && !own && ai.keyState() === 'unreadable',
    // The one set for the whole household, synced with it, which this copy uses unless it has its own.
    household: household
      ? {
          providerName: providerName(household),
          modelName: modelName(household),
          settings: admin ? editable(household) : null,
        }
      : null,
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

/**
 * An admin picks the model: this copy's own, or the household's, which syncs to everyone's devices.
 * It's tried first, unless they say to save it anyway.
 */
export async function saveAiSettings(
  ai: Ai,
  input: z.output<typeof aiSettingsInput>,
  whose: 'own' | 'household' = 'own',
): Promise<{ ok: true; ms: number | null } | { ok: false; error: string }> {
  const preset = aiProvider(input.provider)!;
  const baseUrl = input.provider === 'custom' ? input.baseUrl.replace(/\/+$/, '') : preset.baseUrl;
  if (input.provider === 'custom' && !/^https?:\/\/[^\s/]+/i.test(baseUrl)) throw new DomainError('Add the address of its API, like http://localhost:11434/v1.');
  const current = whose === 'own' ? ai.own() : ai.household();
  // Keep the key already saved when it's for the same provider and none was typed.
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
    const result = await checkSetup(ai, { ...settings, source: whose === 'own' ? 'settings' : 'household' });
    if (!result.ok) return { ok: false, error: result.error };
    ms = result.ms;
  }
  if (whose === 'own') ai.save(settings);
  else ai.saveHousehold(settings);
  return { ok: true, ms };
}
