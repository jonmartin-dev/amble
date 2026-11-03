// A stand-in for the model in tests: answers each structured-output call with whatever the test
// says, and keeps the requests so tests can check what was sent.
import type { Ai, AiSetup } from './client.ts';

export interface FakeRequest {
  system: string;
  content: string;
}

export const fakeSetup: AiSetup = {
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  baseUrl: '',
  apiKey: 'test-key',
  effort: 'medium',
  monthlyCapUsd: 10,
  prices: [0.1, 0.5],
  source: 'environment',
};

export function fakeAi(answer: (req: FakeRequest) => unknown): Ai & { requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  return {
    requests,
    setup: () => fakeSetup,
    own: () => fakeSetup,
    household: () => null,
    available: true,
    async complete(_setup, req) {
      const r = { system: req.system, content: req.content };
      requests.push(r);
      const output = answer(r);
      // Asked to stream, it writes its answer out a few characters at a time first.
      if (req.onText) {
        const text = JSON.stringify(output);
        for (let i = 0; i < text.length; i += 7) req.onText(text.slice(i, i + 7));
      }
      return { output: output as never, problem: null, usage: { input: 1000, output: 100, cached: 0 } };
    },
    save() {
      throw new Error('fakeAi has no settings');
    },
    saveHousehold() {
      throw new Error('fakeAi has no settings');
    },
    keyState: () => 'none',
    server: () => null,
  };
}
