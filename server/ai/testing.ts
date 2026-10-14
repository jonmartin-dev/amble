// A stand-in for Haiku in tests: answers each structured-output call with whatever the test says,
// and keeps the requests so tests can check what was sent.
import type Anthropic from '@anthropic-ai/sdk';
import type { Ai } from './client.ts';

export interface FakeRequest {
  system: string;
  content: string;
}

export function fakeAi(answer: (req: FakeRequest) => unknown): Ai & { requests: FakeRequest[] } {
  const requests: FakeRequest[] = [];
  const client = {
    messages: {
      parse: async (req: { system: string; messages: { content: string }[] }) => {
        const r = { system: req.system, content: req.messages[0]!.content };
        requests.push(r);
        return { stop_reason: 'end_turn', parsed_output: answer(r), usage: { input_tokens: 1000, output_tokens: 100 } };
      },
    },
  } as unknown as Anthropic;
  return { model: 'claude-haiku-5-5', effort: 'medium', monthlyCapUsd: 10, available: true, client, requests };
}
