import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { config, type Config } from '../config.ts';
import { openDatabase, type Db } from '../db/index.ts';
import { serverSettings } from '../db/schema.ts';
import { ask, createAi, jsonIn, savedKeyState, shareRepeats, strictSchema, type AiSetup } from './client.ts';

const testConfig: Config = {
  ...config,
  oidc: { ...config.oidc, clientSecret: 'client-secret' },
  ai: { ...config.ai, provider: 'anthropic', apiKey: '', model: '', baseUrl: '', effort: undefined, prices: undefined },
};

const Answer = z.object({
  items: z.array(
    z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('task'), title: z.string(), minutes: z.number().int() }),
      z.object({ kind: z.literal('note'), text: z.string().describe('Short') }),
    ]),
  ),
  unclear: z.string(),
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> & { messages: { role: string; content: string }[] };
}

/** A pretend OpenAI-style provider: each call gets the next reply. */
function provider(...replies: (Record<string, unknown> | { status: number; error: string })[]) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const reply = replies.shift() ?? { status: 500, error: 'no more replies' };
    if ('status' in reply && typeof reply.status === 'number') return new Response(JSON.stringify({ error: { message: reply.error } }), { status: reply.status });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const answered = (content: string, finish = 'stop') => ({
  choices: [{ finish_reason: finish, message: { content } }],
  usage: { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 200 } },
});

const good = JSON.stringify({ items: [{ kind: 'task', title: 'Call the dentist', minutes: 10 }], unclear: '' });

let modelCount = 0;
/** A setup with a model id of its own, since what a model accepts is remembered per model. */
function setupFor(provider: AiSetup['provider'], extra: Partial<AiSetup> = {}): AiSetup {
  return {
    provider,
    model: `model-${++modelCount}`,
    baseUrl: 'https://llm.test/v1/',
    apiKey: 'sk-test-1234',
    effort: 'medium',
    monthlyCapUsd: 10,
    prices: [0.1, 0.5],
    source: 'settings',
    ...extra,
  };
}

const request = { system: 'You plan.', content: 'call the dentist', schema: Answer, effort: 'low' as const, maxTokens: 1000 };

describe('the JSON schema sent to OpenAI-style providers', () => {
  it('holds every object to its fields, with one-of-a-set as anyOf and constants as enums', () => {
    const schema = strictSchema(Answer) as Record<string, any>;
    expect(schema.$schema).toBeUndefined();
    expect(schema).toMatchObject({ type: 'object', additionalProperties: false, required: ['items', 'unclear'] });
    const variants = schema.properties.items.items.anyOf;
    expect(variants).toHaveLength(2);
    expect(variants[0]).toMatchObject({ additionalProperties: false, required: ['kind', 'title', 'minutes'] });
    expect(variants[0].properties.kind).toMatchObject({ enum: ['task'] });
    expect(variants[0].properties.minutes.minimum).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('oneOf');
  });

  it('finds the JSON inside fences and thinking', () => {
    expect(jsonIn('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(jsonIn('<think>hmm {no}</think>\nHere you go: {"a":1} hope that helps')).toBe('{"a":1}');
  });
});

describe('calling an OpenAI-style provider', () => {
  it('asks for JSON held to the schema, with the effort and key, and reads the answer and usage', async () => {
    const { sent, fetchImpl } = provider(answered(good));
    const ai = createAi(testConfig, undefined, fetchImpl);
    const answer = await ai.complete(setupFor('openai'), request);
    expect(answer.output).toEqual({ items: [{ kind: 'task', title: 'Call the dentist', minutes: 10 }], unclear: '' });
    expect(answer.usage).toEqual({ input: 1000, output: 80, cached: 200 });
    expect(sent[0]!.url).toBe('https://llm.test/v1/chat/completions');
    expect(sent[0]!.headers.authorization).toBe('Bearer sk-test-1234');
    expect(sent[0]!.body).toMatchObject({
      reasoning_effort: 'low',
      max_completion_tokens: 1000,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
      messages: [{ role: 'system', content: 'You plan.' }, { role: 'user', content: 'call the dentist' }],
    });
  });

  it("drops what the provider doesn't take, falls back to plain JSON, and remembers it", async () => {
    const { sent, fetchImpl } = provider(
      { status: 400, error: "Unrecognized request argument supplied: reasoning_effort" },
      { status: 400, error: "Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens'." },
      { status: 400, error: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model." },
      answered('```json\n' + good + '\n```'),
      answered(good),
    );
    const ai = createAi(testConfig, undefined, fetchImpl);
    const setup = setupFor('custom');
    const first = await ai.complete(setup, request);
    expect(first.output?.items).toHaveLength(1);
    expect(sent).toHaveLength(4);
    const last = sent[3]!.body;
    expect(last.reasoning_effort).toBeUndefined();
    expect(last.max_tokens).toBe(1000);
    expect(last.response_format).toEqual({ type: 'json_object' });
    expect(last.messages[0]!.content).toContain('matching this JSON Schema');

    // The next call goes straight to what worked.
    await ai.complete(setup, request);
    expect(sent).toHaveLength(5);
    expect(sent[4]!.body.response_format).toEqual({ type: 'json_object' });
  });

  it('asks Z.ai for a JSON object from the start, and sends no key to a local model without one', async () => {
    const { sent, fetchImpl } = provider(answered(good), answered(good));
    const ai = createAi(testConfig, undefined, fetchImpl);
    await ai.complete(setupFor('zai'), request);
    expect(sent[0]!.body.response_format).toEqual({ type: 'json_object' });
    await ai.complete(setupFor('custom', { apiKey: '', baseUrl: 'http://localhost:11434/v1' }), request);
    expect(sent[1]!.headers.authorization).toBeUndefined();
  });

  it('turns an answer that stops short or does not fit into no answer, and a refused key into an error', async () => {
    const { fetchImpl } = provider(
      answered(good.slice(0, 20), 'length'),
      answered(JSON.stringify({ items: [{ kind: 'task', title: 'x' }], unclear: '' })),
      { status: 401, error: 'Incorrect API key provided' },
    );
    const ai = createAi(testConfig, undefined, fetchImpl);
    expect(await ai.complete(setupFor('openai'), request)).toMatchObject({ output: null, problem: 'stopped early (length)' });
    expect((await ai.complete(setupFor('openai'), request)).problem).toMatch(/doesn't fit \(items\.0\.minutes/);
    await expect(ai.complete(setupFor('openai'), request)).rejects.toThrow('401: Incorrect API key provided');
  });
});

describe('calling Anthropic for a device', () => {
  it("sends the device's schema the way Anthropic takes it, with the enums it refuses moved into descriptions", async () => {
    const sent: { output_config: { format: { schema: unknown } } }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string));
      const message = {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: JSON.stringify({ items: [{ kind: 'note', text: 'hi' }], unclear: '' }) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const ai = createAi(testConfig, undefined, fetchImpl);
    const setup = { ...setupFor('anthropic'), apiKey: 'key-for-a-device-schema' };
    // What the server's /sync/ai passes on: the device's schema, and nothing to check it against.
    const answer = await ai.complete(setup, { ...request, schema: z.unknown(), jsonSchema: strictSchema(Answer) });
    expect(answer.output).toEqual({ items: [{ kind: 'note', text: 'hi' }], unclear: '' });
    const schema = JSON.stringify(sent[0]!.output_config.format.schema);
    expect(schema).not.toContain('"enum"');
    expect(schema).toContain('task');
  });

  it('writes an object that appears more than once a single time, so the grammar stays small, keeping what each place says', () => {
    const Repeat = z.object({ every: z.number().int(), unit: z.enum(['day', 'week']), weekdays: z.array(z.number().int()) });
    const Twice = z.object({
      add: z.object({ title: z.string(), repeat: Repeat }),
      change: z.object({ task: z.string(), repeat: Repeat.describe('Mode none to keep') }),
    });
    const shared = shareRepeats(strictSchema(Twice));
    expect(Object.keys(shared.$defs as object)).toEqual(['shared0']);
    const text = JSON.stringify(shared);
    expect(text.match(/"\$ref":"#\/\$defs\/shared0"/g)).toHaveLength(2);
    expect(text).toContain('{"$ref":"#/$defs/shared0","description":"Mode none to keep"}');
    // Nothing repeated, nothing changed.
    expect(shareRepeats(strictSchema(Answer))).toEqual(strictSchema(Answer));
  });
});

describe('AI settings', () => {
  let db: Db;
  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('come from the environment until an admin saves some, with the key sealed', async () => {
    expect(createAi(testConfig, db).setup()).toBeNull();
    const fromEnv = createAi({ ...testConfig, ai: { ...testConfig.ai, apiKey: 'sk-ant-env' } }, db).setup();
    expect(fromEnv).toMatchObject({ provider: 'anthropic', model: 'claude-haiku-5-5', effort: 'medium', prices: [0.1, 0.5], source: 'environment' });

    const ai = createAi(testConfig, db);
    ai.save({ provider: 'openai', model: 'gpt-6-luna', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-secret-9876', effort: 'medium', monthlyCapUsd: 5, prices: [0.1, 0.5] });
    expect(ai.setup()).toMatchObject({ provider: 'openai', model: 'gpt-6-luna', apiKey: 'sk-secret-9876', monthlyCapUsd: 5, source: 'settings' });
    const stored = JSON.stringify(db.select().from(serverSettings).all());
    expect(stored).not.toContain('sk-secret-9876');
    expect(savedKeyState(db, testConfig)).toBe('saved');

    // A new client secret can't open the old key, so it needs entering again.
    const moved = { ...testConfig, oidc: { ...testConfig.oidc, clientSecret: 'another-secret' } };
    expect(createAi(moved, db).setup()).toBeNull();
    expect(savedKeyState(db, moved)).toBe('unreadable');

    ai.save(null);
    expect(ai.setup()).toBeNull();
  });

  it('a local model needs no key, and a custom one is free unless priced', async () => {
    const local = createAi({ ...testConfig, ai: { ...testConfig.ai, provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen3:4b' } }, db).setup();
    expect(local).toMatchObject({ provider: 'custom', model: 'qwen3:4b', apiKey: '', effort: 'default', prices: null });
  });

  it('meters each call at its prices and stops at the cap', async () => {
    const { fetchImpl } = provider(answered(good), answered(good));
    const ai = createAi(testConfig, db, fetchImpl);
    ai.save({ provider: 'custom', model: 'metered', baseUrl: 'https://llm.test/v1', apiKey: 'k', effort: 'default', monthlyCapUsd: 0.0002, prices: [0.1, 0.5] });
    const { output } = await ask(db, ai, { ...request, feature: 'test', memberId: null, timezone: 'America/Chicago' });
    expect(output.items[0]).toMatchObject({ title: 'Call the dentist' });
    // 1000 in at $0.10, 200 cached at a tenth of that, 80 out at $0.50: $0.000142.
    await expect(ask(db, ai, { ...request, feature: 'test', memberId: null, timezone: 'America/Chicago' })).resolves.toBeTruthy();
    await expect(ask(db, ai, { ...request, feature: 'test', memberId: null, timezone: 'America/Chicago' })).rejects.toThrow(/budget/);
  });
});
