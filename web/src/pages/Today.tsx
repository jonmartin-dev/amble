import { Link, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import Sun from '~icons/material-symbols/wb-sunny-outline-rounded';
import { EventList } from '../components/Events.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { Chip, DoneMark, LoadRing, loadWord, minutesLabel, ScrollRow, SectionTitle, SectionToggle, titleAction } from '../components/ui.tsx';
import type { DayLoad, Task, TimeOfDay } from '../lib/api.ts';
import { firstName, longDate, planningDate } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useBriefing, useEvents, useMe, useMembers, useToday } from '../lib/queries.ts';
import { briefingDue } from './Briefing.tsx';

const sections: { key: TimeOfDay | 'anytime'; title: string }[] = [
  { key: 'morning', title: 'Morning' },
  { key: 'afternoon', title: 'Afternoon' },
  { key: 'evening', title: 'Evening' },
  { key: 'anytime', title: 'Anytime' },
];

function TaskList({ tasks, render }: { tasks: Task[]; render: (t: Task) => React.ReactNode }) {
  return (
    <ul className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {tasks.map((t) => (
          <motion.li
            key={t.id}
            layout
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95, height: 0, marginTop: -8 }}
            transition={expressive.defaultSpatial}
          >
            {render(t)}
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

/**
 * The day's load in one short card: a ring, its word and the hours. Your own day opens the
 * briefing, which has the rest (the calendar, what can wait), and the card says how many picks it has.
 */
function LoadCard({ load, whose, done, picks }: { load: DayLoad; whose: string; done: number; picks?: number }) {
  const word = loadWord(load);
  const hours =
    load.tasks === 0
      ? done
        ? `${done} done today`
        : load.capacityMinutes
          ? `Room for about ${minutesLabel(load.capacityMinutes)}`
          : 'Nothing planned'
      : load.capacityMinutes
        ? `${minutesLabel(load.plannedMinutes)} of ${minutesLabel(load.capacityMinutes)}`
        : `${minutesLabel(load.plannedMinutes)} planned`;
  // With big text the picks go under the rest rather than squeezing it.
  const card = 'flex min-h-16 flex-wrap items-center gap-3 rounded-3xl bg-primary-container py-2.5 pr-2.5 pl-3 text-on-primary-container';
  // Read aloud as it shows, with who it's for first: "Your day: Light, 2 h of 5 h, 3 picks".
  const body = (
    <>
      <LoadRing load={load} />
      <span className="flex min-w-0 grow basis-20 flex-col">
        <span className="sr-only">{whose} day: </span>
        <span className="display text-lg leading-tight font-medium">{word}</span>
        <span className="sr-only">, </span>
        <span className="text-sm">{hours}</span>
      </span>
    </>
  );
  if (picks === undefined)
    return (
      <section aria-label={`${whose} load`} className={card}>
        {body}
      </section>
    );
  return (
    <Link to="/briefing" className={card}>
      {body}
      {picks > 0 ? (
        <span className="ml-auto flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-on-primary-container/8 pr-1.5 pl-3 text-sm font-medium">
          <Sparkle className="size-4.5 text-primary" aria-hidden />
          <span className="sr-only">, </span>
          {picks === 1 ? '1 pick' : `${picks} picks`}
          <ChevronRight className="size-5" aria-hidden />
        </span>
      ) : (
        <>
          <span className="sr-only">, the briefing</span>
          <ChevronRight className="mr-1 size-5 text-on-primary-container/70" aria-hidden />
        </>
      )}
    </Link>
  );
}

export function Today() {
  const me = useMe();
  const { data: household } = useMembers();
  const others = household?.members.filter((m) => m.id !== me?.id) ?? [];
  const [who, setWho] = useState('me');
  const { data } = useToday(who);
  const actions = useTaskActions();
  const [moving, setMoving] = useState<Task | null>(null);
  const [showDone, setShowDone] = useState(false);
  const navigate = useNavigate();
  const briefing = useBriefing();
  const { data: events } = useEvents(data?.today ?? '', data?.today ?? '', !!data && who === 'me');

  // The first open of the day starts with the briefing, which the app usually opens before Today
  // shows at all (main.tsx). This catches the rest: a slow start, or the app brought back on a new day.
  useEffect(() => {
    if (briefing.isFetchedAfterMount && briefingDue(briefing.data)) void navigate({ to: '/briefing' });
  }, [briefing.data, briefing.isFetchedAfterMount, navigate]);

  const today = data?.today ?? '';
  const row = (t: Task, { showDay = false, showTime = true } = {}) => (
    <TaskRow task={t} today={today} meId={me?.id ?? ''} onMove={setMoving} showDay={showDay} showTime={showTime} />
  );
  const planned = data?.planned ?? [];
  const nothingYet = data && planned.length === 0 && data.carriedOver.length === 0 && data.due.length === 0;
  // Nothing left because it all got done, which is worth more than "nothing's planned".
  const allDone = nothingYet && data.done.length > 0;
  const whose = who === 'me' ? 'Your' : who === 'everyone' ? 'Everyone\'s' : `${firstName(others.find((o) => o.id === who)?.name ?? '')}'s`;

  return (
    <>
      <PageHeader eyebrow={longDate(planningDate())} title={`Here's today, ${firstName(me?.name ?? '')}`} short="Today" />

      {others.length > 0 && (
        <ScrollRow className="-mx-4 -mt-2 mb-2 flex gap-2 overflow-x-auto px-4 py-2" role="radiogroup" aria-label="Whose day">
          <Chip selected={who === 'me'} onClick={() => setWho('me')}>
            Mine
          </Chip>
          {others.map((o) => (
            <Chip key={o.id} selected={who === o.id} onClick={() => setWho(o.id)}>
              {firstName(o.name)}
            </Chip>
          ))}
          <Chip selected={who === 'everyone'} onClick={() => setWho('everyone')}>
            Everyone
          </Chip>
        </ScrollRow>
      )}

      {data && <LoadCard load={data.load} whose={whose} done={allDone ? data.done.length : 0} picks={who === 'me' ? briefing.data?.suggestions.length : undefined} />}

      {who === 'me' && events && events.length > 0 && (
        <>
          <SectionTitle>On your calendar</SectionTitle>
          <EventList events={events} date={today} />
        </>
      )}

      {data && data.carriedOver.length > 0 && (
        <>
          <SectionTitle
            action={
              <button type="button" onClick={() => actions.moveAll(data.carriedOver, today, today)} className={titleAction}>
                Bring to today
              </button>
            }
          >
            From earlier
          </SectionTitle>
          <TaskList tasks={data.carriedOver} render={(t) => row(t, { showDay: true })} />
        </>
      )}

      {sections.map(({ key, title }) => {
        const tasks = planned.filter((t) => (t.timeOfDay ?? 'anytime') === key);
        if (tasks.length === 0) return null;
        return (
          <div key={key}>
            <SectionTitle>{title}</SectionTitle>
            <TaskList tasks={tasks} render={(t) => row(t, { showTime: false })} />
          </div>
        );
      })}

      {data && data.due.length > 0 && (
        <>
          <SectionTitle>Due, not planned</SectionTitle>
          <TaskList
            tasks={data.due}
            render={(t) => (
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">{row(t)}</div>
                <button
                  type="button"
                  onClick={() => actions.move(t, today, today)}
                  aria-label={`Do ${t.title} today`}
                  className="press grid size-12 shrink-0 place-items-center rounded-2xl bg-primary-container text-on-primary-container"
                >
                  <Sun className="size-6" aria-hidden />
                </button>
              </div>
            )}
          />
        </>
      )}

      {/* Ticking off the last thing of the day earns a moment; opening Today to it later doesn't replay it. */}
      <AnimatePresence initial={false} mode="popLayout">
        {nothingYet && (
          <motion.div
            key={allDone ? 'done' : 'clear'}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={expressive.defaultSpatial}
            className="mt-10 flex flex-col items-center text-center"
          >
            {allDone && <DoneMark />}
            <p className={`display text-xl font-medium ${allDone ? 'mt-4' : ''}`}>{allDone ? 'All done for today' : 'A clear day'}</p>
            <p className="mt-1 text-on-surface-variant">
              {allDone ? (who === 'me' ? 'Everything you planned is finished. The rest of the day is yours.' : 'Everything planned is finished.') : "Nothing's planned. That's allowed."}
            </p>
            <Link to="/backlog" className="mt-5 inline-block rounded-full bg-surface-high px-5 py-3 font-medium">
              Look at the backlog
            </Link>
          </motion.div>
        )}
      </AnimatePresence>

      {data && data.done.length > 0 && (
        <>
          <SectionToggle open={showDone} onToggle={() => setShowDone((v) => !v)}>
            Done today · {data.done.length}
          </SectionToggle>
          <AnimatePresence initial={false}>
            {showDone && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={expressive.defaultSpatial}>
                <TaskList tasks={data.done} render={(t) => row(t)} />
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <MoveSheet task={moving} today={today} onClose={() => setMoving(null)} />
    </>
  );
}
