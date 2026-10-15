// The AI providers Almanac knows how to talk to, and the fast models it suggests for each. Smart
// add, estimates and the planner's wording only need a quick model that answers in JSON, so the
// suggestions are each provider's small, cheap tier. Any other model id works too.

export type AiProviderId = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'openrouter' | 'custom';
export type AiEffort = 'default' | 'low' | 'medium' | 'high';

export interface AiModel {
  id: string;
  name: string;
  /** US dollars per million tokens, in and out, at the paid rate. */
  price: [number, number];
  /** How hard it thinks on smart add. "default" sends nothing and leaves it to the model. */
  effort: AiEffort;
  /** Has a free tier, or is free outright. */
  free?: 'tier' | 'model';
}

export interface AiProvider {
  id: AiProviderId;
  name: string;
  /** Where its OpenAI-style API lives; empty for Anthropic's own and for one the admin types in. */
  baseUrl: string;
  /** Where to make a key. */
  keyUrl?: string;
  /** Whether it can be held to a JSON schema, or only asked for any JSON object. */
  json: 'schema' | 'object';
  /** Fastest first; the first is the default. */
  models: AiModel[];
  note?: string;
  /**
   * When Almanac runs on a device, calls go straight from the browser, which only works if the
   * provider allows it (CORS). Checked with a preflight on 2026-10-15.
   */
  fromBrowser: boolean;
  /** What to know about using it from a device, if anything. */
  deviceNote?: string;
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: '',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    json: 'schema',
    models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', price: [0.1, 0.5], effort: 'medium' }],
    fromBrowser: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys',
    json: 'schema',
    models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', price: [0.1, 0.5], effort: 'medium' }],
    fromBrowser: true,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    json: 'schema',
    models: [
      { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', price: [0.25, 1.5], effort: 'default', free: 'tier' },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', price: [0.1, 0.4], effort: 'default', free: 'tier' },
    ],
    note: "Gemini's free tier needs no card. On it, Google may use what's sent to improve its products.",
    fromBrowser: true,
  },
  {
    id: 'zai',
    name: 'Z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    json: 'object',
    models: [
      { id: 'glm-4.7-flash', name: 'GLM-4.7-Flash', price: [0, 0], effort: 'default', free: 'model' },
      { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', price: [0.15, 0.5], effort: 'default' },
    ],
    fromBrowser: false,
    deviceNote: "Z.ai doesn't take calls straight from a browser. Use GLM through OpenRouter here, or from your own Almanac server.",
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    json: 'schema',
    models: [
      { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5', price: [0.1, 0.5], effort: 'medium' },
      { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', price: [0.1, 0.5], effort: 'medium' },
      { id: 'google/gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash-Lite', price: [0.25, 1.5], effort: 'default' },
      { id: 'z-ai/glm-4.7-flash', name: 'GLM-4.7-Flash', price: [0.06, 0.4], effort: 'default' },
    ],
    note: 'One key for models from every provider.',
    fromBrowser: true,
  },
  {
    id: 'custom',
    name: 'Other',
    baseUrl: '',
    json: 'schema',
    models: [],
    note: 'Any service with an OpenAI-style API: Ollama (http://localhost:11434/v1) or LM Studio (http://localhost:1234/v1) on your own machine, Groq, Mistral, DeepSeek and others.',
    fromBrowser: true,
    deviceNote:
      "From a browser, the service has to allow it: start Ollama with OLLAMA_ORIGINS set to this page's address, or turn on CORS in LM Studio's server settings.",
  },
];

export function aiProvider(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}

export function aiModel(provider: string, model: string): AiModel | undefined {
  return aiProvider(provider)?.models.find((m) => m.id === model);
}

/** What to call a model on screen: its name when Almanac knows it, its id otherwise. */
export function aiModelName(provider: string, model: string) {
  return aiModel(provider, model)?.name ?? model;
}
