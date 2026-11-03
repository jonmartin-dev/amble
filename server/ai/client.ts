// The household's AI calls: one model, from whichever provider the admin set up, every call
// metered, and a monthly cap so a self-hoster is never surprised by the bill. Anthropic is spoken
// to through its own SDK; everyone else through the OpenAI-style chat completions API that most
// providers offer (OpenAI, Gemini, Z.ai, OpenRouter, Ollama and the rest). A device with no model
// of its own uses the household's: one an admin set for everyone, which syncs through Google Drive
// with what each device spent on it, or the household's own server's, which it asks
// (server/sync/hub.ts) and which keeps the key and the cap.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiModel, aiModelName, aiProvider, type AiEffort, type AiProviderId } from '../../shared/ai.ts';
import { isLines, readLines } from '../../shared/lines.ts';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { aiUsage, householdAiSpend, householdSettings, serverSettings } from '../db/schema.ts';
import { seal, unseal } from '../lib/seal.ts';

export type Effort = 'low' | 'medium' | 'high';

/** Why an AI feature can't run right now; the app falls back to doing things as typed. */
export class AiUnavailable extends Error {}

/** A model and how to reach it. */
export interface AiSetup {
  provider: AiProviderId;
  model: string;
  /** Where its OpenAI-style API lives (unused for Anthropic). */
  baseUrl: string;
  apiKey: string;
  /** Smart add's effort. "default" sends none on any call and leaves it to the model. */
  effort: AiEffort;
  monthlyCapUsd: number;
  /** US dollars per million tokens, in and out, when Amble or the admin knows them. */
  prices: [number, number] | null;
  /**
   * Saved in Settings for this copy alone, read from the server's environment, set for the whole
   * household and synced with it (on Google Drive), or the household's server's, which a device asks.
   */
  source: 'settings' | 'environment' | 'household' | 'server';
}

/** The household's server's model, for a device with none of its own: where to ask, and what it is. */
export interface RemoteAi {
  url: string;
  token: string;
  provider: AiProviderId;
  model: string;
  effort: AiEffort;
}

export interface AiUsage {
  input: number;
  output: number;
  /** Input tokens the provider had cached, which cost a fraction. */
  cached: number;
}

export interface AiRequest<T extends z.ZodType> {
  system: string;
  content: string;
  schema: T;
  /** The answer's JSON Schema, when it came from elsewhere (a device asking the server); else made from `schema`. */
  jsonSchema?: Record<string, unknown>;
  /** Which feature asks, for the server a device asks to meter it by. */
  feature?: string;
  /** Null sends no effort at all. */
  effort: Effort | null;
  maxTokens: number;
  /** Each piece of the answer's text as the model writes it, for a feature that shows it coming. */
  onText?: (piece: string) => void;
}

export interface AiAnswer<T> {
  /** Null when it stopped early or answered with something that isn't the JSON asked for. */
  output: T | null;
  problem: string | null;
  usage: AiUsage;
}

export interface Ai {
  /** What's in use: this copy's own, else the household's, else the household's server's, else nothing. */
  setup(): AiSetup | null;
  /** This copy's own: from Settings, else from the environment. */
  own(): AiSetup | null;
  /** The one the household set for everyone, synced with it. */
  household(): AiSetup | null;
  readonly available: boolean;
  /** One structured call. Throws when the provider can't be reached or refuses the request. */
  complete<T extends z.ZodType>(setup: AiSetup, req: AiRequest<T>): Promise<AiAnswer<z.output<T>>>;
  /** Keeps a model set up in the app, or with null goes back to the environment's. */
  save(settings: AiSettings | null): void;
  /** Keeps the household's model, synced to everyone's devices, or with null takes it away. */
  saveHousehold(settings: AiSettings | null): void;
  /** Whether a key saved in the app can still be opened, for Settings to say so. */
  keyState(): 'none' | 'saved' | 'unreadable';
  /** The household's server's model, which this device would use without one of its own. */
  server(): AiSetup | null;
}

/** How a saved key is kept: sealed on the server; on a device, as the device keeps everything else. */
export interface KeyBox {
  seal(key: string): string;
  /** The key, or undefined when it can't be opened anymore. */
  open(sealed: string): string | undefined;
}

/** Sealed under the server's OAuth client secret, like calendar tokens (server/lib/seal.ts). */
export const sealedKeys = (secret: string): KeyBox => ({
  seal: (key) => seal(secret, KEY_PURPOSE, key),
  open: (sealed) => unseal(secret, KEY_PURPOSE, sealed),
});

/** What the admin sets in Settings, AI. */
export interface AiSettings {
  provider: AiProviderId;
  model: string;
  baseUrl: string;
  /** Left empty to keep the key already saved for this provider. */
  apiKey: string;
  effort: AiEffort;
  monthlyCapUsd: number;
  prices: [number, number] | null;
}

interface Stored extends Omit<AiSettings, 'apiKey'> {
  key: string;
}

const KEY_PURPOSE = 'ai api key';

/** The setup the environment describes: AMBLE_AI_* (or ANTHROPIC_API_KEY on its own). */
export function fromEnvironment(config: Config): AiSetup | null {
  const { provider, apiKey, model, baseUrl, effort, monthlyCapUsd, prices } = config.ai;
  const known = aiProvider(provider);
  if (!known) return null;
  const url = baseUrl || known.baseUrl;
  // A model on your own machine (Ollama, LM Studio) needs no key.
  if (!apiKey && !(provider === 'custom' && url)) return null;
  const chosen = model || known.models[0]?.id;
  if (!chosen || (provider !== 'anthropic' && !url)) return null;
  const preset = aiModel(provider, chosen);
  return {
    provider,
    model: chosen,
    baseUrl: url,
    apiKey,
    effort: effort ?? preset?.effort ?? 'default',
    monthlyCapUsd,
    prices: prices ?? preset?.price ?? null,
    source: 'environment',
  };
}

export function createAi(
  config: Config,
  db?: Db,
  fetchImpl: typeof fetch = fetch,
  keys: KeyBox = sealedKeys(config.oidc.clientSecret),
  /** The household's server's model, when this is a device syncing with one. */
  remote?: () => RemoteAi | null,
): Ai {
  let cached: { setup: AiSetup | null } | null = null;

  // The server keeps the cap and counts what it costs, so here it's neither capped nor priced.
  const fromServer = (): AiSetup | null => {
    const r = remote?.();
    return r ? { provider: r.provider, model: r.model, baseUrl: '', apiKey: '', effort: r.effort, monthlyCapUsd: Infinity, prices: null, source: 'server' } : null;
  };

  const read = (): AiSetup | null => {
    const row = db?.select().from(serverSettings).where(eq(serverSettings.key, 'ai')).get();
    if (!row) return fromEnvironment(config);
    const saved = row.value as Stored;
    const apiKey = saved.key ? keys.open(saved.key) : '';
    // A key sealed under an old client secret can't be read; it needs entering again.
    if (apiKey === undefined) return null;
    return { ...saved, apiKey, source: 'settings' };
  };

  // The household's, as the last round of sync left it: read every time, since a round can change it.
  const household = (): AiSetup | null => {
    const saved = db?.select().from(householdSettings).where(eq(householdSettings.key, 'ai')).get()?.value as AiSettings | undefined;
    // From another device's Amble, so only a shape this one knows.
    if (!saved || !aiProvider(saved.provider) || !saved.model) return null;
    return { ...saved, source: 'household' };
  };

  const ai: Ai = {
    setup() {
      return ai.own() ?? household() ?? fromServer();
    },
    own() {
      cached ??= { setup: read() };
      return cached.setup;
    },
    household,
    get available() {
      return ai.setup() != null;
    },
    complete(setup, req) {
      if (setup.source === 'server') {
        const r = remote?.();
        if (!r) throw new Error('This device stopped syncing with the server.');
        return serverCall(r, req, fetchImpl);
      }
      return setup.provider === 'anthropic' ? anthropicCall(setup, req, fetchImpl) : chatCall(setup, req, fetchImpl);
    },
    save(settings) {
      if (!db) throw new Error('No database to keep AI settings in.');
      cached = null;
      if (!settings) {
        db.delete(serverSettings).where(eq(serverSettings.key, 'ai')).run();
        return;
      }
      const { apiKey, ...rest } = settings;
      const before = db.select().from(serverSettings).where(eq(serverSettings.key, 'ai')).get()?.value as Stored | undefined;
      const key = apiKey ? keys.seal(apiKey) : before?.provider === settings.provider ? before.key : '';
      const value: Stored = { ...rest, key };
      db.insert(serverSettings).values({ key: 'ai', value }).onConflictDoUpdate({ target: serverSettings.key, set: { value } }).run();
    },
    // In the household's synced copy, key and all: everyone's devices call the model with it.
    saveHousehold(settings) {
      if (!db) throw new Error('No database to keep AI settings in.');
      if (!settings) {
        db.delete(householdSettings).where(eq(householdSettings.key, 'ai')).run();
        return;
      }
      db.insert(householdSettings).values({ key: 'ai', value: settings }).onConflictDoUpdate({ target: householdSettings.key, set: { value: settings } }).run();
    },
    keyState: () => (db ? savedKeyState(db, config, keys) : 'none'),
    server: fromServer,
  };
  return ai;
}

/**
 * On a server: a model the household set while it synced through Google Drive becomes the server's
 * own, sealed like any other (unless the server has one already), and leaves the household's synced
 * copy, so the key stops travelling with it. Says whether anything changed.
 */
export function adoptHouseholdAi(ai: Ai) {
  const household = ai.household();
  if (!household) return false;
  if (!ai.own()) {
    const { source: _, ...settings } = household;
    ai.save(settings);
  }
  ai.saveHousehold(null);
  return true;
}

/** Whether a saved setup still has a key the server can open (for Settings to say so). */
export function savedKeyState(db: Db, config: Config, keys: KeyBox = sealedKeys(config.oidc.clientSecret)): 'none' | 'saved' | 'unreadable' {
  const saved = db.select().from(serverSettings).where(eq(serverSettings.key, 'ai')).get()?.value as Stored | undefined;
  if (!saved?.key) return 'none';
  return keys.open(saved.key) === undefined ? 'unreadable' : 'saved';
}

/** What to call the model in messages: "Claude Haiku 5.5", or the id of one Amble doesn't know. */
export function modelName(setup: Pick<AiSetup, 'provider' | 'model'>) {
  return aiModelName(setup.provider, setup.model);
}

/** The effort to send for a call that would like `wanted`: none when the setup leaves it to the model. */
export function effortFor(setup: AiSetup, wanted: Effort): Effort | null {
  return setup.effort === 'default' ? null : wanted;
}

// ---- Anthropic ---------------------------------------------------------------------------------

const anthropicClients = new Map<string, { client: Anthropic; fetchImpl: typeof fetch }>();

function anthropicFor(setup: AiSetup, fetchImpl: typeof fetch) {
  let kept = anthropicClients.get(setup.apiKey);
  if (kept?.fetchImpl !== fetchImpl) {
    // Smart add waits on this call, so fail fast and fall back rather than hang.
    // On a device the call goes straight from the app's worker, which Anthropic allows when asked.
    const onDevice = typeof document !== 'undefined' || 'WorkerGlobalScope' in globalThis;
    const client = new Anthropic({ apiKey: setup.apiKey, timeout: 45_000, maxRetries: 1, dangerouslyAllowBrowser: onDevice, fetch: fetchImpl });
    anthropicClients.set(setup.apiKey, (kept = { client, fetchImpl }));
  }
  return kept.client;
}

/**
 * Writes each object that appears more than once in a schema (but for its description) once,
 * under $defs, and points to it from each place, which keeps its own description. Anthropic
 * compiles a schema into a grammar with a size limit, and every copy counts: smart add's, with its
 * repeat settings written out twice, went over ("The compiled grammar is too large").
 */
export function shareRepeats(schema: Record<string, unknown>): Record<string, unknown> {
  type Node = Record<string, unknown>;
  let root = structuredClone(schema);
  const defs: Record<string, Node> = {};
  const keyOf = (node: Node) => JSON.stringify({ ...node, description: undefined });
  const isObject = (node: Node) => node.type === 'object' && node.properties != null;
  for (let n = 0; ; n++) {
    const counts = new Map<string, number>();
    const walk = (node: unknown, top: boolean) => {
      if (Array.isArray(node)) return node.forEach((x) => walk(x, false));
      if (!node || typeof node !== 'object') return;
      if (!top && isObject(node as Node)) counts.set(keyOf(node as Node), (counts.get(keyOf(node as Node)) ?? 0) + 1);
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties') for (const p of Object.values(v as Node)) walk(p, false);
        else walk(v, false);
      }
    };
    walk(root, true);
    for (const d of Object.values(defs)) walk(d, false);
    // The biggest first, so what's inside it is shared along with it.
    const repeated = [...counts].filter(([, c]) => c > 1).sort((a, b) => b[0].length - a[0].length)[0]?.[0];
    if (!repeated) break;
    const name = `shared${n}`;
    defs[name] = JSON.parse(repeated) as Node;
    const swap = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(swap);
      if (!node || typeof node !== 'object') return node;
      const o = node as Node;
      if (isObject(o) && keyOf(o) === repeated) return { $ref: `#/$defs/${name}`, ...(o.description != null && { description: o.description }) };
      return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, swap(v)]));
    };
    root = swap(root) as Node;
    for (const k of Object.keys(defs)) if (k !== name) defs[k] = swap(defs[k]) as Node;
  }
  return Object.keys(defs).length ? { ...root, $defs: defs } : root;
}

/**
 * A call with a JSON Schema that came from elsewhere (a device asking the server): the answer is
 * checked against `schema` afterwards, on the device too. Repeated parts go once, to keep the
 * grammar small; enums stay, so the model can only answer with what the check allows (the SDK's
 * own transform turns them into descriptions, and then the model made up values that failed it).
 */
async function anthropicRawCall<T extends z.ZodType>(
  setup: AiSetup,
  req: AiRequest<T> & { jsonSchema: Record<string, unknown> },
  fetchImpl: typeof fetch,
): Promise<AiAnswer<z.output<T>>> {
  const client = anthropicFor(setup, fetchImpl);
  const params = {
    model: setup.model,
    max_tokens: req.maxTokens,
    output_config: { ...(req.effort && { effort: req.effort }), format: { type: 'json_schema' as const, schema: shareRepeats(req.jsonSchema) } },
    system: req.system,
    messages: [{ role: 'user' as const, content: req.content }],
  };
  const response = req.onText ? await streamed(client.messages.stream(params), req.onText) : await client.messages.create(params);
  const u = response.usage;
  const usage = { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cached: u.cache_read_input_tokens ?? 0 };
  if (response.stop_reason !== 'end_turn') return { output: null, problem: `stopped early (${response.stop_reason})`, usage };
  const text = response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  return checked(req.schema, text, usage);
}

/** The message a stream ends with, each piece of its text handed on as it comes. */
function streamed<R>(stream: { on(event: 'text', fn: (piece: string) => void): unknown; finalMessage(): Promise<R> }, onText: (piece: string) => void) {
  stream.on('text', onText);
  return stream.finalMessage();
}

/** Parses an answer's JSON and holds it to the schema. */
function checked<T extends z.ZodType>(schema: T, text: string, usage: AiUsage): AiAnswer<z.output<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonIn(text));
  } catch {
    return { output: null, problem: 'answered with something other than JSON', usage };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const where = result.error.issues[0]?.path.join('.') || 'the answer';
    return { output: null, problem: `answered with JSON that doesn't fit (${where}: ${result.error.issues[0]?.message})`, usage };
  }
  return { output: result.data as z.output<T>, problem: null, usage };
}

async function anthropicCall<T extends z.ZodType>(setup: AiSetup, req: AiRequest<T>, fetchImpl: typeof fetch): Promise<AiAnswer<z.output<T>>> {
  if (req.jsonSchema) return anthropicRawCall(setup, { ...req, jsonSchema: req.jsonSchema }, fetchImpl);
  const client = anthropicFor(setup, fetchImpl);
  const params = {
    model: setup.model,
    max_tokens: req.maxTokens,
    output_config: { ...(req.effort && { effort: req.effort }), format: zodOutputFormat(req.schema) },
    system: req.system,
    messages: [{ role: 'user' as const, content: req.content }],
  };
  const response = req.onText ? await streamed(client.messages.stream(params), req.onText) : await client.messages.parse(params);
  const u = response.usage;
  const usage = { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens, cached: u.cache_read_input_tokens ?? 0 };
  const ok = response.stop_reason === 'end_turn' && response.parsed_output != null;
  return { output: ok ? (response.parsed_output as z.output<T>) : null, problem: ok ? null : `stopped early (${response.stop_reason})`, usage };
}

// ---- OpenAI-style chat completions -------------------------------------------------------------

interface Quirks {
  /** Held to a schema, asked for any JSON object, or just told in the prompt. */
  json: 'schema' | 'object' | 'prompt';
  effort: boolean;
  maxTokens: 'max_completion_tokens' | 'max_tokens';
  /** Whether it can send its answer as it writes it. */
  stream: boolean;
}

// What each address and model turned out to accept, learned from the errors it gave, so only the
// first call after a start pays for finding out.
const quirks = new Map<string, Quirks>();

/** The change to make after a request was refused, or null when the refusal isn't about its shape. */
function adjust(q: Quirks, error: string): Partial<Quirks> | null {
  if (q.stream && /\bstream/i.test(error)) return { stream: false };
  if (q.effort && /reasoning/i.test(error)) return { effort: false };
  if (q.maxTokens === 'max_completion_tokens' && /max_completion_tokens/i.test(error)) return { maxTokens: 'max_tokens' };
  if (q.json === 'schema' && /response_format|json_schema|schema|strict/i.test(error)) return { json: 'object' };
  if (q.json === 'object' && /response_format|json_object|json/i.test(error)) return { json: 'prompt' };
  return null;
}

/**
 * The schema as a plain JSON Schema that strict modes accept: every field required, nothing extra,
 * one of a set as anyOf, and constants as one-value enums.
 */
export function strictSchema(schema: z.ZodType): Record<string, unknown> {
  const tidy = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(tidy);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$schema') continue;
      if ((k === 'minimum' || k === 'maximum') && typeof v === 'number' && Math.abs(v) >= Number.MAX_SAFE_INTEGER) continue;
      if (k === 'oneOf') out.anyOf = tidy(v);
      else if (k === 'const') out.enum = [v];
      else out[k] = tidy(v);
    }
    if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys(out.properties);
    }
    return out;
  };
  return tidy(z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' })) as Record<string, unknown>;
}

/** The JSON in an answer, without the code fences or thinking some models wrap around it. */
export function jsonIn(text: string) {
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fenced) s = fenced[1]!.trim();
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start >= 0 && end > start) s = s.slice(start, end + 1);
  }
  return s;
}

/** The message in an API's error body, whatever shape it comes in. */
function errorMessage(body: string) {
  try {
    const data = JSON.parse(body);
    const first = Array.isArray(data) ? data[0] : data;
    const err = first?.error ?? first;
    const message = typeof err === 'string' ? err : (err?.message ?? first?.message);
    if (typeof message === 'string' && message) return message.slice(0, 300);
  } catch {
    // Not JSON.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no details';
}

interface ChatAnswer {
  choices?: { finish_reason?: string | null; message?: { content?: string | { type?: string; text?: string }[] | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
}

/** An answer sent as it's written (server-sent events), put back together as one answer. */
async function chatStream(res: Response, onText: (piece: string) => void): Promise<ChatAnswer> {
  let content = '';
  let refusal = '';
  let finish: string | null = null;
  let usage: ChatAnswer['usage'] = null;
  await readLines(res.body!, (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    const chunk = JSON.parse(data) as {
      choices?: { finish_reason?: string | null; delta?: { content?: string | null; refusal?: string | null } }[];
      usage?: ChatAnswer['usage'];
      error?: { message?: string } | string;
    };
    if (chunk.error) throw new Error(typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'the answer stopped with an error'));
    const choice = chunk.choices?.[0];
    if (choice?.delta?.content) {
      content += choice.delta.content;
      onText(choice.delta.content);
    }
    if (choice?.delta?.refusal) refusal += choice.delta.refusal;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (chunk.usage) usage = chunk.usage;
  });
  return { choices: [{ finish_reason: finish, message: { content, refusal: refusal || null } }], usage };
}

async function chatCall<T extends z.ZodType>(setup: AiSetup, req: AiRequest<T>, fetchImpl: typeof fetch): Promise<AiAnswer<z.output<T>>> {
  const id = `${setup.baseUrl}|${setup.model}`;
  const q: Quirks = { ...(quirks.get(id) ?? { json: aiProvider(setup.provider)?.json ?? 'schema', effort: true, maxTokens: 'max_completion_tokens', stream: true }) };
  const schema = req.jsonSchema ?? strictSchema(req.schema);
  const url = `${setup.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const system =
      q.json === 'schema'
        ? req.system
        : `${req.system}\n\nAnswer with one JSON object and nothing else, matching this JSON Schema:\n${JSON.stringify(schema)}`;
    const body = {
      model: setup.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: req.content },
      ],
      [q.maxTokens]: req.maxTokens,
      ...(q.effort && req.effort && { reasoning_effort: req.effort }),
      ...(q.json === 'schema' && { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } } }),
      ...(q.json === 'object' && { response_format: { type: 'json_object' } }),
      ...(req.onText && q.stream && { stream: true, stream_options: { include_usage: true } }),
      // Only route to a host that honours the JSON format, rather than one that ignores it.
      ...(setup.provider === 'openrouter' && { provider: { require_parameters: true } }),
    };
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(setup.apiKey && { authorization: `Bearer ${setup.apiKey}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const message = errorMessage(await res.text());
      const fix = res.status === 400 || res.status === 422 ? adjust(q, message) : null;
      if (!fix) throw new Error(`${res.status}: ${message}`);
      Object.assign(q, fix);
      quirks.set(id, { ...q });
      continue;
    }
    quirks.set(id, { ...q });
    const data = req.onText && res.headers.get('content-type')?.includes('event-stream') ? await chatStream(res, req.onText) : ((await res.json()) as ChatAnswer);
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage = { input: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached), output: data.usage?.completion_tokens ?? 0, cached };
    const choice = data.choices?.[0];
    const finish = choice?.finish_reason;
    if (finish === 'length' || finish === 'content_filter') return { output: null, problem: `stopped early (${finish})`, usage };
    if (choice?.message?.refusal) return { output: null, problem: `declined: ${choice.message.refusal.slice(0, 200)}`, usage };
    const raw = choice?.message?.content;
    const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((p) => p.text ?? '').join('') : '';
    return checked(req.schema, text, usage);
  }
  throw new Error("refused every way Amble knows to ask for JSON");
}

// ---- the household's server, for a device --------------------------------------------------------

type ServerAnswer = { output?: unknown; usage?: AiUsage; error?: string };

/** Asks the household's server's model. The server meters it; the answer is checked here, against the real schema. */
async function serverCall<T extends z.ZodType>(r: RemoteAi, req: AiRequest<T>, fetchImpl: typeof fetch): Promise<AiAnswer<z.output<T>>> {
  const res = await fetchImpl(`${r.url}/sync/ai`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${r.token}` },
    body: JSON.stringify({
      feature: req.feature ?? 'device',
      system: req.system,
      content: req.content,
      schema: strictSchema(req.schema),
      effort: req.effort,
      maxTokens: req.maxTokens,
      ...(req.onText && { stream: true }),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  let body: ServerAnswer | null = null;
  // Asked for the words as they come, a server that can sends them a line at a time, the answer last.
  if (res.ok && req.onText && isLines(res)) {
    const onText = req.onText;
    await readLines(res.body!, (line) => {
      const l = JSON.parse(line) as ServerAnswer & { text?: string };
      if (typeof l.text === 'string') onText(l.text);
      else body = l;
    });
    const last = body as ServerAnswer | null;
    if (!last) throw new Error('the server stopped before it answered');
    if (last.error) throw new Error(last.error);
  } else body = (await res.json().catch(() => null)) as ServerAnswer | null;
  if (!res.ok) throw new Error(body?.error ?? `the server answered ${res.status}`);
  const usage = body?.usage ?? { input: 0, output: 0, cached: 0 };
  return checked(req.schema, JSON.stringify(body?.output ?? null), usage);
}

// ---- metering ----------------------------------------------------------------------------------

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

const monthKey = (timezone: string) => Temporal.Now.plainDateISO(timezone).toPlainYearMonth().toString();

/** What everyone's devices spent this month with the household's model, as far as this copy has heard. */
export function householdSpendUsd(db: Db, timezone: string) {
  const [row] = db
    .select({ micros: sql<number>`coalesce(sum(${householdAiSpend.micros}), 0)` })
    .from(householdAiSpend)
    .where(eq(householdAiSpend.month, monthKey(timezone)))
    .all();
  return (row?.micros ?? 0) / 1_000_000;
}

/** Adds a call with the household's model to this device's row, which syncs to the others. */
function addHouseholdSpend(db: Db, timezone: string, micros: number) {
  if (micros <= 0) return;
  // This copy's id in sync (server/sync/service.ts), which only the household's model needs.
  const site = (db.select().from(serverSettings).where(eq(serverSettings.key, 'sync')).get()?.value as { site?: string } | undefined)?.site ?? 'here';
  db.insert(householdAiSpend)
    .values({ site, month: monthKey(timezone), micros })
    .onConflictDoUpdate({ target: [householdAiSpend.site, householdAiSpend.month], set: { micros: sql`${householdAiSpend.micros} + ${micros}` } })
    .run();
}

/** This month's spending against the cap of the model in use: the household's together, or this copy's own. */
export const spentAgainst = (setup: AiSetup, db: Db, timezone: string) =>
  setup.source === 'household' ? householdSpendUsd(db, timezone) : monthSpendUsd(db, timezone);

/** Millionths of a dollar; cached input at a tenth, roughly what providers charge. */
export function costMicros(prices: [number, number] | null, usage: AiUsage) {
  if (!prices) return 0;
  const [input, output] = prices;
  return Math.round(usage.input * input + usage.cached * input * 0.1 + usage.output * output);
}

export function recordUsage(
  db: Db,
  entry: { memberId: string | null; feature: string; model: string; effort: string; prices: [number, number] | null; usage?: AiUsage; durationMs: number; ok: boolean },
) {
  db.insert(aiUsage)
    .values({
      memberId: entry.memberId,
      feature: entry.feature,
      model: entry.model,
      effort: entry.effort,
      inputTokens: (entry.usage?.input ?? 0) + (entry.usage?.cached ?? 0),
      outputTokens: entry.usage?.output ?? 0,
      costMicros: entry.usage ? costMicros(entry.prices, entry.usage) : 0,
      durationMs: entry.durationMs,
      ok: entry.ok,
    })
    .run();
}

/** Throws AiUnavailable when no model is set up or this month's spending has reached the cap. */
export function requireAi(ai: Ai, db: Db, timezone: string): AiSetup {
  const setup = ai.setup();
  if (!setup) throw new AiUnavailable('No AI model is set up on the server.');
  if (spentAgainst(setup, db, timezone) >= setup.monthlyCapUsd) {
    throw new AiUnavailable(`This month's AI budget ($${setup.monthlyCapUsd}) is used up.`);
  }
  return setup;
}

/**
 * One metered call for a feature: checks the budget, records what it cost, and throws
 * AiUnavailable when there's no usable answer, so the feature can fall back.
 */
export async function ask<T extends z.ZodType>(
  db: Db,
  ai: Ai,
  req: AiRequest<T> & { feature: string; memberId: string | null; timezone: string },
): Promise<{ output: z.output<T>; usage: AiUsage; ms: number; setup: AiSetup }> {
  const setup = requireAi(ai, db, req.timezone);
  const name = modelName(setup);
  const entry = { memberId: req.memberId, feature: req.feature, model: setup.model, effort: req.effort ?? 'default', prices: setup.prices };
  const started = performance.now();
  let answer: AiAnswer<z.output<T>>;
  try {
    answer = await ai.complete(setup, req);
  } catch (err) {
    recordUsage(db, { ...entry, durationMs: Math.round(performance.now() - started), ok: false });
    throw new AiUnavailable(`${name} didn't answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const ms = Math.round(performance.now() - started);
  recordUsage(db, { ...entry, usage: answer.usage, durationMs: ms, ok: answer.output != null });
  if (setup.source === 'household') addHouseholdSpend(db, req.timezone, costMicros(setup.prices, answer.usage));
  if (answer.output == null) throw new AiUnavailable(`${name} ${answer.problem ?? 'gave no answer'}.`);
  return { output: answer.output, usage: answer.usage, ms, setup };
}

// ---- checking a setup --------------------------------------------------------------------------

const Check = z.object({ minutes: z.number().int().describe('How many minutes it takes') });

/** One tiny call, to see whether a setup works before it's saved. Costs a fraction of a cent. */
export async function checkSetup(ai: Ai, setup: AiSetup): Promise<{ ok: true; ms: number } | { ok: false; error: string }> {
  const started = performance.now();
  try {
    const answer = await ai.complete(setup, {
      system: 'You estimate how long household tasks take.',
      content: 'How long does it take to call the dentist to book a cleaning?',
      schema: Check,
      effort: effortFor(setup, 'low'),
      maxTokens: 2000,
    });
    if (answer.output == null) return { ok: false, error: `It ${answer.problem ?? 'gave no answer'}.` };
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Who the AI features send things to, and whose key, for the privacy page: { provider, name, source }, or null. */
export function aiProviderFor(ai: Ai) {
  const setup = ai.setup();
  return setup ? { provider: setup.provider, name: aiProvider(setup.provider)?.name ?? setup.provider, source: setup.source } : null;
}
