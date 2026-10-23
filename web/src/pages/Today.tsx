import { Link, useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import ChevronRight from '~icons/material-symbols/chevron-right-rounded';
import Sparkle from '~icons/material-symbols/auto-awesome-outline-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import Sun from '~icons/material-symbols/wb-sunny-outline-rounded';
import { calendarLine, EventList } from '../components/Events.tsx';
import { MoveSheet } from '../components/MoveSheet.tsx';
import { PageHeader } from '../components/PageHeader.tsx';
import { TaskRow } from '../components/TaskRow.tsx';
import { Chip, DoneMark, LoadBar, loadWord, minutesLabel, ScrollRow, SectionTitle } from '../components/ui.tsx';
import type { Task, TimeOfDay } from '../lib/api.ts';
import { firstName, longDate, planningDate } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { useBriefing, useEvents, useMe, useMembers, useToday } from '../lib/queries.ts';
import { briefingShown } from './Briefing.tsx';

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

  // The first open of the day starts with the briefing, once it's fresh from the server.
  useEffect(() => {
    const b = briefing.data;
    if (b && !b.seen && briefing.isFetchedAfterMount && !briefingShown(b.date)) void navigate({ to: '/briefing' });
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
        <ScrollRow className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4" role="radiogroup" aria-label="Whose day">
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

      {data && (
        <section className="rounded-[2rem] bg-primary-container p-5 text-on-primary-container">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm">{whose} load</h2>
            <p className="display text-2xl font-medium">{loadWord(data.load)}</p>
          </div>
          <LoadBar load={data.load} className="mt-3" fill="bg-on-primary-container" />
          <p className="mt-3 text-sm">
            {data.load.tasks === 0
              ? allDone
                ? `Everything's done: ${data.done.length} finished today.`
                : 'Nothing planned yet. Add something with the plus button, or pull one in from the backlog.'
              : `${data.load.tasks} planned, about ${minutesLabel(data.load.plannedMinutes)} of ${minutesLabel(data.load.capacityMinutes)}.`}
            {who !== 'everyone' && calendarLine(data.load, who === 'me' ? 'your' : 'their') && ` ${calendarLine(data.load, who === 'me' ? 'your' : 'their')}`}
          </p>
        </section>
      )}

      {who === 'me' && briefing.data && briefing.data.suggestions.length > 0 && (
        <Link to="/briefing" className="mt-2 flex items-center gap-3 rounded-3xl bg-surface-low py-3 pr-3 pl-4 transition-colors hover:bg-surface-container">
          <Sparkle className="size-5 text-primary" aria-hidden />
          <span className="flex-1 text-sm">
            {briefing.data.suggestions.length === 1 ? '1 thing' : `${briefing.data.suggestions.length} things`} worth doing today
          </span>
          <ChevronRight className="size-5 text-on-surface-variant" aria-hidden />
        </Link>
      )}

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
              <button
                type="button"
                onClick={() => actions.moveAll(data.carriedOver, today, today)}
                className="rounded-full px-3 py-1 text-sm font-medium text-primary hover:bg-surface-high"
              >
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
          <button
            type="button"
            onClick={() => setShowDone((v) => !v)}
            aria-expanded={showDone}
            className="mt-7 mb-2 flex w-full items-center justify-between px-1 text-sm font-medium text-primary"
          >
            Done today · {data.done.length}
            <motion.span animate={{ rotate: showDone ? 180 : 0 }} transition={expressive.fastSpatial}>
              <ExpandMore className="size-5" aria-hidden />
            </motion.span>
          </button>
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
