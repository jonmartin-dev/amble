import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.ts';
import { aiUsage, members, tasks, type Member } from '../db/schema.ts';
import { seedStarterGroups } from '../db/seed.ts';
import { resolveGroup, type Actor } from '../domain/household.ts';
import { getStats } from '../domain/stats.ts';
import { createTasks, getTask, updateTask } from '../domain/tasks.ts';
import { createAi } from './client.ts';
import { createEstimator } from './estimate.ts';
import { fakeAi } from './testing.ts';
import { config } from '../config.ts';

let db: Db;
let jon: Member;
let earlier: Actor;

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago' }).returning().get();
  // Made a minute ago, so the estimator doesn't wait for someone to size them first.
  earlier = { member: jon, via: 'app', at: new Date(Date.now() - 60_000) };
});

describe('background estimates', () => {
  it('sizes unsized open tasks in one call, with the household\'s own sizes as examples', async () => {
    const home = resolveGroup(db, jon, 'Home').id;
    const [gutters, call] = createTasks(db, earlier, [
      { title: 'Clean the gutters', groupId: home, subtasks: ['Get the ladder', 'Bag the leaves'] },
      { title: 'Call the vet' },
    ]);
    createTasks(db, earlier, [{ title: 'Mow the lawn', estimateMinutes: 50 }]);
    createTasks(db, { member: jon, via: 'app' }, [{ title: 'Just added' }]);
    const ai = fakeAi(({ content }) => {
      expect(content).toContain('Mow the lawn: 50 min');
      expect(content).toMatch(/t1 Call the vet\n|t\d Clean the gutters · group: Home · steps: Get the ladder; Bag the leaves/);
      expect(content).not.toContain('Just added');
      const ref = (title: string) => content.split('\n').find((l) => l.includes(title))!.split(' ')[0]!;
      return { estimates: [{ task: ref('Clean the gutters'), minutes: 92 }, { task: ref('Call the vet'), minutes: 8 }, { task: 't99', minutes: 5 }] };
    });
    const estimator = createEstimator(db, ai, 'America/Chicago');
    expect(await estimator.run()).toBe(2);
    expect(getTask(db, jon, gutters!.id)).toMatchObject({ estimateMinutes: 90, estimateSource: 'ai', aiEstimateMinutes: 90 });
    expect(getTask(db, jon, call!.id)).toMatchObject({ estimateMinutes: 8, estimateSource: 'ai' });
    expect(db.select().from(aiUsage).where(eq(aiUsage.feature, 'estimate')).all()).toHaveLength(1);
    // Nothing left to size.
    expect(await estimator.run()).toBe(0);
    expect(ai.requests).toHaveLength(1);
  });

  it('leaves a task someone sized while Haiku was thinking, and gives up on one Haiku keeps skipping', async () => {
    const [t] = createTasks(db, earlier, [{ title: 'Renew passport' }]);
    const ai = fakeAi(() => {
      updateTask(db, { member: jon, via: 'app' }, t!.id, { estimateMinutes: 40 });
      return { estimates: [{ task: 't1', minutes: 20 }] };
    });
    expect(await createEstimator(db, ai, 'America/Chicago').run()).toBe(0);
    expect(getTask(db, jon, t!.id)).toMatchObject({ estimateMinutes: 40, estimateSource: 'user', aiEstimateMinutes: null });

    createTasks(db, earlier, [{ title: 'Something vague' }]);
    const skipping = fakeAi(() => ({ estimates: [] }));
    const estimator = createEstimator(db, skipping, 'America/Chicago');
    await estimator.run();
    await estimator.run();
    await estimator.run();
    expect(skipping.requests).toHaveLength(2);
  });

  it('does nothing without an API key', async () => {
    createTasks(db, earlier, [{ title: 'Call the vet' }]);
    expect(await createEstimator(db, createAi({ ...config, ai: { ...config.ai, apiKey: '' } }), 'America/Chicago').run()).toBe(0);
  });
});

describe('estimate accuracy', () => {
  it('counts the guesses people kept and how far they moved the rest', () => {
    const made = createTasks(
      db,
      earlier,
      [10, 30, 60, 20].map((m, i) => ({ title: `Guessed ${i}`, estimateMinutes: m, estimateSource: 'ai' as const })),
    );
    const asJon: Actor = { member: jon, via: 'app' };
    updateTask(db, asJon, made[0]!.id, { estimateMinutes: 20 });
    updateTask(db, asJon, made[1]!.id, { estimateMinutes: 45 });
    updateTask(db, asJon, made[2]!.id, { estimateMinutes: 30 });
    // Cleared without a number of its own: no verdict either way.
    db.update(tasks).set({ estimateMinutes: null, estimateSource: null }).where(eq(tasks.id, made[3]!.id)).run();
    createTasks(db, earlier, [{ title: 'Sized by hand', estimateMinutes: 15 }]);
    const { estimates } = getStats(db, jon);
    expect(estimates).toMatchObject({ made: 3, kept: 0, raised: 2, lowered: 1, typicalRatio: 1.5 });
    expect(estimates.months.at(-1)).toMatchObject({ made: 3, kept: 0 });
  });
});
