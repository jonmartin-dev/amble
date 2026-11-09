import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import { calendarLine, EventList } from '../components/Events.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { ButtonGroup, LoadBar, loadWord, minutesLabel, SectionTitle, titleAction } from '../components/ui.tsx';
import type { Briefing as BriefingData, Outlook, Suggestion, Task } from '../lib/api.ts';
import { addDays, dayLabel, longDate, planningDate } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useSend, useTaskActions } from '../lib/mutations.ts';
import { useBriefing, useMe } from '../lib/queries.ts';

const SHOWN_KEY = 'almanac.briefingShown';

/** Remembers on this device that today's briefing came up, so it opens by itself only once. */
export function briefingShown(date: string) {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === date;
  } catch {
    return false;
  }
}

/** Whether the briefing opens by itself: today's, not seen on any device, and not shown here yet. */
export function briefingDue(b: BriefingData | undefined) {
  return !!b && !b.seen && !briefingShown(b.date);
}

function rememberShown(date: string) {
  try {
    sessionStorage.setItem(SHOWN_KEY, date);
  } catch {
    // Without storage it may come up again this session; harmless.
  }
}

const OUTLOOKS: { value: Outlook | 'normal'; label: string }[] = [
  { value: 'lighter', label: 'Lighter' },
  { value: 'normal', label: 'Normal' },
  { value: 'rough', label: 'Rough' },
];

/** "Fold the laundry, Call the vet and 2 more" */
function someOf(tasks: Task[]) {
  const titles = tasks.slice(0, tasks.length > 3 ? 2 : 3).map((t) => t.title);
  if (tasks.length > 3) titles.push(`${tasks.length - 2} more`);
  return titles.length === 1 ? titles[0]! : `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
}

function SuggestionCard({
  s,
  added,
  fits,
  onAdd,
  onLater,
  today,
}: {
  s: Suggestion;
  added: boolean;
  /** Whether it fits in the room today has now, which changes as things come and go. */
  fits: boolean;
  onAdd: () => void;
  onLater: () => void;
  today: string;
}) {
  const meta = [s.task.dueDate && `Due ${dayLabel(s.task.dueDate, today, true)}`, s.task.groupName, s.task.estimateMinutes && minutesLabel(s.task.estimateMinutes)].filter(Boolean);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, height: 0, marginTop: -8 }}
      transition={expressive.defaultSpatial}
      className="rounded-[1.75rem] bg-surface-low p-4"
    >
      <Link to="/task/$taskId" params={{ taskId: s.task.id }} className="block">
        <p className="font-medium">{s.task.title}</p>
        {meta.length > 0 && <p className="mt-0.5 text-sm text-on-surface-variant">{meta.join(' · ')}</p>}
        <p className="mt-2 text-on-surface-variant">{s.reason}</p>
      </Link>
      <div className="mt-3 flex items-center gap-2">
        <AnimatePresence mode="wait" initial={false}>
          {added ? (
            <motion.span
              key="added"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={expressive.fastSpatial}
              className="flex h-10 items-center gap-1.5 rounded-full bg-primary-container px-4 text-sm font-medium text-on-primary-container"
            >
              <Check className="size-5" aria-hidden />
              On today
            </motion.span>
          ) : (
            <motion.button key="add" type="button" onClick={onAdd} className="press h-10 rounded-full bg-primary px-5 text-sm font-medium text-on-primary">
              Add to today
            </motion.button>
          )}
        </AnimatePresence>
        {!added && (
          <button type="button" onClick={onLater} className="h-10 rounded-full px-4 text-sm font-medium text-primary hover:bg-surface-high">
            Later
          </button>
        )}
        {!fits && !added && <span className="ml-auto text-xs text-warm">Today's already full</span>}
      </div>
    </motion.li>
  );
}

/**
 * "Here's today": the first thing someone sees each morning. How the day is looking, how full it
 * is, what's on the calendar, what was handed over, and a few things worth pulling in, each with a
 * reason. Nothing changes until they tap Add.
 */
export function Briefing() {
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const send = useSend();
  const actions = useTaskActions();
  const { data, isFetchedAfterMount } = useBriefing();
  // The suggestions as they first came for how the day is looking, so cards don't jump about as
  // the day fills; saying it's rough or lighter brings a fresh set. Kept only from a fresh read,
  // not the copy saved from the last visit.
  const [shown, setShown] = useState<{ outlook: Outlook | null; list: Suggestion[] } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [moving, setMoving] = useState<Task | null>(null);
  // Picked here, shown at once while the day's room catches up.
  const [picked, setPicked] = useState<Outlook | 'normal' | null>(null);
  const today = data?.date ?? '';
  const outlook = picked ?? data?.outlook ?? 'normal';

  useEffect(() => {
    if (data && isFetchedAfterMount && (shown === null || shown.outlook !== data.outlook)) setShown({ outlook: data.outlook, list: data.suggestions });
  }, [data, isFetchedAfterMount, shown]);

  // Opening it counts as seeing it, so it doesn't come up again today on another device.
  useEffect(() => {
    if (!data || data.seen) return;
    rememberShown(data.date);
    qc.setQueryData<BriefingData>(['briefing'], (b) => b && { ...b, seen: true });
    send('POST', '/briefing/seen', {}, "See today's briefing");
  }, [data, qc, send]);

  const add = (s: Suggestion) => {
    setAdded((a) => new Set(a).add(s.task.id));
    actions.move(s.task, today, today);
  };
  const later = (s: Suggestion) => {
    setShown((was) => was && { ...was, list: was.list.filter((x) => x.task.id !== s.task.id) });
    send('POST', '/briefing/later', { taskId: s.task.id }, `Put off ${s.task.title}`);
  };
  const look = (v: Outlook | 'normal') => {
    setPicked(v);
    send('POST', '/briefing/outlook', { outlook: v === 'normal' ? null : v }, 'Say how today is looking');
  };

  const line = data && calendarLine(data.load);
  const suggestions = shown?.list ?? data?.suggestions ?? [];
  const rough = outlook === 'rough';
  // Deciding ahead what gives keeps a plan useful on a day that doesn't go to plan.
  const canWait = data && (rough || data.load.level === 'full' || data.load.level === 'over') ? data.canWait : [];

  return (
    <>
      <header className="mb-6">
        <p className="text-sm text-on-surface-variant">{longDate(planningDate())}</p>
        <h1 className="display mt-1 text-[2.25rem] leading-[1.1] font-medium">{data?.greeting ?? `Here's today`}</h1>
      </header>

      {data && (
        <div className="mb-4">
          <h2 className="mb-2 px-1 text-sm text-on-surface-variant">How's today looking?</h2>
          <ButtonGroup size="sm" label="How's today looking?" value={outlook} options={OUTLOOKS} onChange={look} />
        </div>
      )}

      {data && (
        <section className="rounded-[2rem] bg-primary-container p-5 text-on-primary-container">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm">Your day</h2>
            <p className="display text-2xl font-medium">{loadWord(data.load)}</p>
          </div>
          <LoadBar load={data.load} className="mt-3" fill="bg-on-primary-container" />
          <p className="mt-3 text-sm">
            {data.load.tasks === 0
              ? data.load.capacityMinutes
                ? `Nothing planned yet, with room for about ${minutesLabel(data.load.capacityMinutes)}.`
                : 'Nothing planned, and no task time set aside today.'
              : data.load.capacityMinutes === 0
                ? `${data.load.tasks} planned, about ${minutesLabel(data.load.plannedMinutes)}, on a day with no room set aside.`
                : `${data.load.tasks} planned, about ${minutesLabel(data.load.plannedMinutes)} of ${minutesLabel(data.load.capacityMinutes)}.`}
            {line && ` ${line}`}
          </p>
          {canWait.length > 0 && (
            <div className="mt-4 border-t border-on-primary-container/15 pt-4">
              <p className="text-sm">
                {rough ? 'On a rough day, these can wait' : 'If today goes sideways, these can wait'}: {someOf(canWait)}.
              </p>
              {rough && (
                <button
                  type="button"
                  onClick={() => actions.moveAll(canWait, addDays(today, 1), today)}
                  className="press mt-3 h-10 rounded-full bg-primary px-4 text-sm font-medium text-on-primary"
                >
                  {canWait.length === 1 ? 'Move it to tomorrow' : 'Move them to tomorrow'}
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {data && data.events.length > 0 && (
        <>
          <SectionTitle>On your calendar</SectionTitle>
          <EventList events={data.events} date={today} />
        </>
      )}

      {data && data.handedOver.length > 0 && (
        <>
          <SectionTitle>Handed to you</SectionTitle>
          <ul className="flex flex-col gap-2">
            {data.handedOver.map((h) => (
              <li key={h.task.id}>
                <Link to="/task/$taskId" params={{ taskId: h.task.id }} className="block rounded-[1.75rem] bg-secondary-container p-4 text-on-secondary-container">
                  <p className="text-sm">From {h.from}</p>
                  <p className="mt-0.5 font-medium">{h.task.title}</p>
                  {h.note && <p className="mt-1 text-sm">"{h.note}"</p>}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {data && data.carriedOver.length > 0 && (
        <>
          <SectionTitle
            action={
              <button
                type="button"
                onClick={() => actions.moveAll(data.carriedOver, today, today)}
                className={titleAction}
              >
                Bring to today
              </button>
            }
          >
            From earlier
          </SectionTitle>
          <ul className="flex flex-col gap-2">
            {data.carriedOver.map((t) => (
              <li key={t.id}>
                <TaskRow task={t} today={today} meId={me?.id ?? ''} onMove={setMoving} showDay />
              </li>
            ))}
          </ul>
        </>
      )}

      {data && (
        <>
          <SectionTitle>Worth doing today</SectionTitle>
          {suggestions.length === 0 ? (
            <p className="rounded-3xl bg-surface-low p-5 text-on-surface-variant">Nothing pressing. The backlog can wait.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {suggestions.map((s) => (
                  <SuggestionCard
                    key={s.task.id}
                    s={s}
                    today={today}
                    added={added.has(s.task.id)}
                    fits={(s.task.estimateMinutes ?? 30) <= data.load.capacityMinutes - data.load.plannedMinutes}
                    onAdd={() => add(s)}
                    onLater={() => later(s)}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
        </>
      )}

      <button type="button" onClick={() => void navigate({ to: '/' })} className="press mt-8 h-14 w-full rounded-full bg-primary text-lg font-medium text-on-primary">
        Start my day
      </button>

      <MoveSheet task={moving} today={today} onClose={() => setMoving(null)} />
    </>
  );
}
