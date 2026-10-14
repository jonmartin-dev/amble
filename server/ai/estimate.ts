// Sizes for tasks that arrive without one: added from the plain form, by Claude, or offline. A
// background job sends them to Haiku in batches, with the household's own estimates as examples,
// and fills in the gaps. Anything someone sizes themselves in the meantime is left alone.
import { and, desc, eq, inArray, isNull, lt } from 'drizzle-orm';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { Db } from '../db/index.ts';
import { groups, subtasks, tasks } from '../db/schema.ts';
import { AiUnavailable, recordUsage, requireAi, type Ai } from './client.ts';
import { ownEstimates, roundEstimate } from './smartAdd.ts';

const BATCH = 40;
const EXAMPLES = 30;
// Give someone a moment to size a task themselves before Haiku does.
const SETTLE_MS = 30_000;
const MAX_TRIES = 2;

const Output = z.object({
  estimates: z.array(
    z.object({
      task: z.string().describe('The task ref, like t3'),
      minutes: z.number().int().describe('Minutes of actually doing it'),
    }),
  ),
});

const SYSTEM = `You estimate how long household tasks take: minutes of actually doing the task, not waiting around it. Give one estimate for every task listed.

Match this household's own estimates when similar tasks are listed; they know their pace. Otherwise: quick calls, messages and small admin 5-15; small chores 15-30; errands 30-60; bigger jobs 60-240. A task's steps say how big it is. Round to 5 minutes above 10.`;

export function createEstimator(db: Db, ai: Ai, timezone: string) {
  // Tasks Haiku skipped or that failed, so a bad one isn't sent forever.
  const tries = new Map<string, number>();

  /** Sizes up to one batch of unsized open tasks. Returns how many got an estimate. */
  async function run(): Promise<number> {
    if (!ai.available) return 0;
    const pending = db
      .select({ id: tasks.id, title: tasks.title, notes: tasks.notes, group: groups.name })
      .from(tasks)
      .leftJoin(groups, eq(tasks.groupId, groups.id))
      .where(and(eq(tasks.status, 'open'), isNull(tasks.estimateMinutes), isNull(tasks.aiEstimateMinutes), lt(tasks.createdAt, new Date(Date.now() - SETTLE_MS))))
      .orderBy(desc(tasks.createdAt))
      .limit(BATCH * 2)
      .all()
      .filter((t) => (tries.get(t.id) ?? 0) < MAX_TRIES)
      .slice(0, BATCH);
    if (pending.length === 0) return 0;

    let client;
    try {
      client = requireAi(ai, db, timezone);
    } catch (err) {
      if (err instanceof AiUnavailable) return 0;
      throw err;
    }
    for (const t of pending) tries.set(t.id, (tries.get(t.id) ?? 0) + 1);

    const steps = db.select({ taskId: subtasks.taskId, title: subtasks.title }).from(subtasks).where(inArray(subtasks.taskId, pending.map((t) => t.id))).all();
    const refs = new Map(pending.map((t, i) => [`t${i + 1}`, t.id]));
    const examples = ownEstimates(db, EXAMPLES);
    const lines = pending.map((t, i) => {
      const own = steps.filter((s) => s.taskId === t.id).map((s) => s.title);
      return [
        `t${i + 1} ${t.title}`,
        t.group && `group: ${t.group}`,
        own.length && `steps: ${own.join('; ')}`,
        t.notes && `notes: ${t.notes.replace(/\s+/g, ' ').slice(0, 200)}`,
      ]
        .filter(Boolean)
        .join(' · ');
    });
    const content = [
      examples.length ? `How long things take here (their own estimates):\n${examples.map((e) => `${e.title}: ${e.minutes} min`).join('\n')}` : 'This household has no estimates of its own yet.',
      `Tasks to estimate:\n${lines.join('\n')}`,
    ].join('\n\n');

    const started = performance.now();
    let response;
    try {
      response = await client.messages.parse({
        model: ai.model,
        max_tokens: 4000,
        output_config: { effort: 'low', format: zodOutputFormat(Output) },
        system: SYSTEM,
        messages: [{ role: 'user', content }],
      });
    } catch (err) {
      recordUsage(db, { memberId: null, feature: 'estimate', model: ai.model, effort: 'low', durationMs: Math.round(performance.now() - started), ok: false });
      throw err;
    }
    const ok = response.stop_reason === 'end_turn' && response.parsed_output != null;
    recordUsage(db, { memberId: null, feature: 'estimate', model: ai.model, effort: 'low', usage: response.usage, durationMs: Math.round(performance.now() - started), ok });
    if (!ok) return 0;

    let filled = 0;
    db.transaction(() => {
      for (const e of response.parsed_output!.estimates) {
        const id = refs.get(e.task);
        const minutes = roundEstimate(e.minutes);
        if (!id || !minutes) continue;
        // Not touching updatedAt: this fills a gap quietly rather than changing the task.
        const done = db
          .update(tasks)
          .set({ estimateMinutes: minutes, estimateSource: 'ai', aiEstimateMinutes: minutes })
          .where(and(eq(tasks.id, id), isNull(tasks.estimateMinutes)))
          .run();
        filled += done.changes;
      }
    });
    return filled;
  }

  return { run };
}
