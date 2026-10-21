import { useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import AttachFile from '~icons/material-symbols/attach-file-rounded';
import Check from '~icons/material-symbols/check-rounded';
import Checklist from '~icons/material-symbols/checklist-rounded';
import Event from '~icons/material-symbols/event-outline-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import LinkIcon from '~icons/material-symbols/link-rounded';
import Notes from '~icons/material-symbols/notes-rounded';
import Bell from '~icons/material-symbols/notifications-outline-rounded';
import Person from '~icons/material-symbols/person-outline-rounded';
import RepeatIcon from '~icons/material-symbols/repeat-rounded';
import Sun from '~icons/material-symbols/wb-sunny-outline-rounded';
import type { Task } from '../lib/api.ts';
import { dayLabel, daysFrom, firstName, reminderLabel } from '../lib/dates.ts';
import { swapsDetail } from '../lib/layout.ts';
import { motionChoices, useMotion } from '../lib/motion-demo.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { TripBadge } from './TripList.tsx';
import { Checkbox } from './ui.tsx';

// How far the finger has to travel to finish or move a task. The row follows at half that, so it
// feels like it resists being pulled.
const SWIPE = 96;
const FOLLOW = 0.5;
// Movement that decides between a swipe, a scroll, and a press.
const SLOP = 8;

interface Props {
  task: Task;
  today: string;
  meId: string;
  onMove: (task: Task) => void;
  /** Show which day it's planned for (the backlog does; the day list doesn't need to). */
  showDay?: boolean;
  showGroup?: boolean;
  /** Off where a section header already says the time of day. */
  showTime?: boolean;
  /** The row's own color, so it still stands out on a surface like a sheet. */
  surface?: string;
}

/** One task. Swipe right to complete, swipe left or long-press to move it, tap for details. */
export function TaskRow({ task, today, meId, onMove, showDay = false, showGroup = true, showTime = true, surface = 'bg-surface-low' }: Props) {
  const navigate = useNavigate();
  const router = useRouter();
  const actions = useTaskActions();
  const motion = useMotion();
  // Open beside the list on a wide screen, where the row stays in view.
  const open = useRouterState({ select: (s) => s.location.pathname === `/task/${task.id}` });
  // A tap shows right away; once the server's copy of the task changes (done, or undone), it wins.
  const [tapped, setTapped] = useState<{ done: boolean; version: string } | null>(null);
  const checked = tapped && tapped.version === task.updatedAt ? tapped.done : task.status === 'done';
  // What shows behind the row only exists while it's being swiped, so a long list builds less.
  const [swiping, setSwiping] = useState(false);
  // A long press or a swipe ends in a click event too; `handled` swallows that click.
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; handled: boolean; x: number; y: number }>({ handled: false, x: 0, y: 0 });
  // The swipe moves the row directly, without React, so it keeps up with the finger. Nothing here
  // measures the page, so a list of rows is cheap to build.
  const row = useRef<HTMLDivElement>(null);
  const doneBg = useRef<HTMLDivElement | null>(null);
  const moveBg = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ state: 'idle' | 'pending' | 'swiping' | 'scrolling'; dx: number }>({ state: 'idle', dx: 0 });
  // Which side's line the swipe is past, so crossing it pops the icon and ticks once.
  const past = useRef<'done' | 'move' | null>(null);

  const toggle = () => {
    const next = !checked;
    setTapped({ done: next, version: task.updatedAt });
    // Let the check animation play before the row moves to its new section.
    setTimeout(() => actions.complete(task, next), next && motionChoices().finish ? 520 : 320);
  };

  const startPress = (e: React.PointerEvent) => {
    press.current = { handled: false, x: e.clientX, y: e.clientY };
    press.current.timer = setTimeout(() => {
      press.current.handled = true;
      navigator.vibrate?.(10);
      onMove(task);
    }, 520);
  };
  const cancelPress = () => clearTimeout(press.current.timer);

  // The row slides by half the finger's travel; what's behind it shows as it goes.
  const paint = () => {
    const offset = drag.current.dx * FOLLOW;
    if (row.current) row.current.style.transform = offset ? `translateX(${offset}px)` : '';
    if (doneBg.current) doneBg.current.style.opacity = String(Math.min(Math.max(offset / (SWIPE * FOLLOW), 0), 1));
    if (moveBg.current) moveBg.current.style.opacity = String(Math.min(Math.max(-offset / (SWIPE * FOLLOW), 0), 1));
    const side = drag.current.dx > SWIPE ? 'done' : drag.current.dx < -SWIPE ? 'move' : null;
    if (side !== past.current) {
      past.current = side;
      const icon = (side === 'done' ? doneBg : moveBg).current?.firstElementChild;
      if (side && icon && motionChoices().swipePop) {
        navigator.vibrate?.(12);
        icon.animate({ transform: ['scale(1)', 'scale(1.45)', 'scale(1.15)'] }, { duration: 320, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
      } else if (!side) {
        for (const bg of [doneBg, moveBg]) bg.current?.firstElementChild?.getAnimations().forEach((a) => a.cancel());
      }
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { state: 'pending', dx: 0 };
    startPress(e);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d.state === 'idle' || d.state === 'scrolling') return;
    const dx = e.clientX - press.current.x;
    const dy = e.clientY - press.current.y;
    if (d.state === 'pending') {
      if (Math.abs(dx) + Math.abs(dy) <= SLOP) return;
      cancelPress();
      // Mostly up or down: a scroll, which the browser handles (the row only takes sideways pans).
      if (Math.abs(dy) >= Math.abs(dx)) {
        d.state = 'scrolling';
        return;
      }
      d.state = 'swiping';
      press.current.handled = true;
      if (row.current) {
        row.current.setPointerCapture(e.pointerId);
        // Its own layer while it moves, so following the finger doesn't repaint it.
        row.current.style.willChange = 'transform';
      }
      setSwiping(true);
    }
    d.dx = dx;
    paint();
  };

  const onPointerEnd = () => {
    cancelPress();
    const d = drag.current;
    const wasSwiping = d.state === 'swiping';
    d.state = 'idle';
    past.current = null;
    if (!wasSwiping) return;
    if (d.dx > SWIPE) toggle();
    else if (d.dx < -SWIPE) onMove(task);
    // Spring back as a browser animation, then let go of what was behind the row, which stays
    // as it was so the row slides back over it.
    const el = row.current;
    const from = el?.style.transform;
    d.dx = 0;
    if (el) el.style.transform = '';
    const settle = () => {
      if (el) el.style.willChange = '';
      setSwiping(false);
    };
    if (!el || !from || matchMedia('(prefers-reduced-motion: reduce)').matches) return settle();
    const easing = getComputedStyle(el).getPropertyValue('--spring-fast').trim() || 'ease-out';
    el.animate([{ transform: from }, { transform: 'translateX(0)' }], { duration: 350, easing }).finished.then(settle, settle);
  };

  const due = task.dueDate ? daysFrom(today, task.dueDate) : null;
  const fromSomeoneElse = task.createdById && task.createdById !== meId && task.assigneeId === meId;
  const subtasksDone = task.subtasks.filter((s) => s.done).length;

  return (
    <div className={`relative overflow-hidden rounded-3xl ${motion.press ? 'press-row' : ''}`} data-morph={`/task/${task.id}`}>
      {swiping && (
        <>
          <div
            ref={(el) => {
              doneBg.current = el;
              if (el && drag.current.state === 'swiping') paint();
            }}
            className="absolute inset-0 flex items-center bg-primary-container pl-5 text-on-primary-container opacity-0"
          >
            <Check className="size-6" aria-hidden />
          </div>
          <div
            ref={(el) => {
              moveBg.current = el;
              if (el && drag.current.state === 'swiping') paint();
            }}
            className="absolute inset-0 flex items-center justify-end bg-secondary-container pr-5 text-on-secondary-container opacity-0"
          >
            <Event className="size-6" aria-hidden />
          </div>
        </>
      )}
      <div
        ref={row}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClick={() => {
          if (press.current.handled) return;
          void navigate({ to: '/task/$taskId', params: { taskId: task.id }, replace: swapsDetail(router.state.location.pathname) });
        }}
        onContextMenu={(e) => e.preventDefault()}
        aria-current={open || undefined}
        className={`state-layer relative isolate flex cursor-pointer touch-pan-y items-start gap-3 px-4 py-3.5 select-none ${open ? 'bg-secondary-container' : surface}`}
      >
        {/* Just finished: a wash of color sweeps across the row. */}
        {motion.finish && tapped?.done && checked && <span aria-hidden className="row-sweep absolute inset-0 -z-10 bg-primary-container" />}
        <div className="pt-0.5">
          <Checkbox checked={checked} onChange={toggle} label={checked ? `Mark ${task.title} not done` : `Complete ${task.title}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`leading-snug transition-colors ${checked ? 'text-on-surface-variant' : ''} ${checked && !(motion.finish && tapped?.done) ? 'line-through' : ''}`}>
            {/* Just finished: the line draws itself through the title. */}
            {checked && motion.finish && tapped?.done ? <span className="strike-draw">{task.title}</span> : task.title}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-on-surface-variant empty:hidden">
            {task.mustDo && (
              <span className="flex items-center gap-1 text-warm">
                <Flag className="size-4" aria-hidden />
                Must do
              </span>
            )}
            {showGroup && task.groupName && <span>{task.groupName}</span>}
            {task.listId && <TripBadge task={task} />}
            {showDay && task.plannedDate && (
              <span className="flex items-center gap-1">
                <Sun className="size-4" aria-hidden />
                {dayLabel(task.plannedDate, today)}
              </span>
            )}
            {due !== null && (
              <span className={due <= 0 && task.status === 'open' ? 'font-medium text-warm' : ''}>
                {due < 0 ? `Was due ${dayLabel(task.dueDate!, today, true)}` : `Due ${dayLabel(task.dueDate!, today, true)}`}
              </span>
            )}
            {showTime && task.timeOfDay && <span className="capitalize">{task.timeOfDay}</span>}
            {task.subtasks.length > 0 && (
              <span className="flex items-center gap-1">
                <Checklist className="size-4" aria-hidden />
                {subtasksDone}/{task.subtasks.length}
              </span>
            )}
            {task.reminder && !task.reminder.sentAt && task.status === 'open' && (
              <span className="flex items-center gap-1">
                <Bell className="size-4" aria-label="Reminder" />
                {reminderLabel(task.reminder.at)}
              </span>
            )}
            {task.repeat && <RepeatIcon className="size-4" aria-label="Repeats" />}
            {task.links.length > 0 && <LinkIcon className="size-4" aria-label="Has links" />}
            {task.files?.length > 0 && <AttachFile className="size-4" aria-label="Has files" />}
            {task.notes && <Notes className="size-4" aria-label="Has notes" />}
            {task.assigneeId !== meId && (
              <span className="flex items-center gap-1">
                <Person className="size-4" aria-hidden />
                {task.assigneeName ? firstName(task.assigneeName) : 'Anyone'}
              </span>
            )}
            {fromSomeoneElse && <span className="text-primary">From {firstName(task.createdByName ?? '')}</span>}
          </div>
          {task.handedBackNote && task.assigneeId === meId && (
            <p className="mt-1.5 rounded-xl bg-surface-high px-3 py-1.5 text-sm text-on-surface-variant">"{task.handedBackNote}"</p>
          )}
        </div>
      </div>
    </div>
  );
}
