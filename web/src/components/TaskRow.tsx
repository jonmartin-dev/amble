import { useNavigate } from '@tanstack/react-router';
import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react';
import { useRef, useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import Checklist from '~icons/material-symbols/checklist-rounded';
import Event from '~icons/material-symbols/event-outline-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import LinkIcon from '~icons/material-symbols/link-rounded';
import Notes from '~icons/material-symbols/notes-rounded';
import Person from '~icons/material-symbols/person-outline-rounded';
import Sun from '~icons/material-symbols/wb-sunny-outline-rounded';
import type { Task } from '../lib/api.ts';
import { dayLabel, daysFrom, firstName } from '../lib/dates.ts';
import { expressive } from '../lib/motion.ts';
import { useTaskActions } from '../lib/mutations.ts';
import { Checkbox } from './ui.tsx';

const SWIPE = 96;

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
  const actions = useTaskActions();
  // A tap shows right away; once the server's copy of the task changes (done, or undone), it wins.
  const [tapped, setTapped] = useState<{ done: boolean; version: string } | null>(null);
  const checked = tapped && tapped.version === task.updatedAt ? tapped.done : task.status === 'done';
  const x = useMotionValue(0);
  const doneOpacity = useTransform(x, [0, SWIPE], [0, 1]);
  const moveOpacity = useTransform(x, [-SWIPE, 0], [1, 0]);
  // A long press or a swipe ends in a click event too; `handled` swallows that click.
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; handled: boolean; x: number; y: number }>({ handled: false, x: 0, y: 0 });

  const toggle = () => {
    const next = !checked;
    setTapped({ done: next, version: task.updatedAt });
    // Let the check animation play before the row moves to its new section.
    setTimeout(() => actions.complete(task, next), 320);
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > SWIPE) toggle();
    else if (info.offset.x < -SWIPE) onMove(task);
    void animate(x, 0, expressive.fastSpatial);
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

  const due = task.dueDate ? daysFrom(today, task.dueDate) : null;
  const fromSomeoneElse = task.createdById && task.createdById !== meId && task.assigneeId === meId;
  const subtasksDone = task.subtasks.filter((s) => s.done).length;

  return (
    <div className="relative overflow-hidden rounded-3xl">
      <motion.div style={{ opacity: doneOpacity }} className="absolute inset-0 flex items-center bg-primary-container pl-5 text-on-primary-container">
        <Check className="size-6" aria-hidden />
      </motion.div>
      <motion.div style={{ opacity: moveOpacity }} className="absolute inset-0 flex items-center justify-end bg-secondary-container pr-5 text-on-secondary-container">
        <Event className="size-6" aria-hidden />
      </motion.div>
      <motion.div
        style={{ x }}
        drag="x"
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0.5}
        dragDirectionLock
        onDragStart={() => {
          cancelPress();
          press.current.handled = true;
        }}
        onDragEnd={onDragEnd}
        onPointerDown={startPress}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        onPointerMove={(e) => {
          if (Math.abs(e.clientX - press.current.x) + Math.abs(e.clientY - press.current.y) > 8) cancelPress();
        }}
        onClick={() => {
          if (press.current.handled) return;
          void navigate({ to: '/task/$taskId', params: { taskId: task.id } });
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative flex cursor-pointer items-start gap-3 px-4 py-3.5 select-none ${surface}`}
      >
        <div className="pt-0.5">
          <Checkbox checked={checked} onChange={toggle} label={checked ? `Mark ${task.title} not done` : `Complete ${task.title}`} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={`leading-snug transition-colors ${checked ? 'text-on-surface-variant line-through' : ''}`}>{task.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] text-on-surface-variant empty:hidden">
            {task.mustDo && (
              <span className="flex items-center gap-1 text-warm">
                <Flag className="size-4" aria-hidden />
                Must do
              </span>
            )}
            {showGroup && task.groupName && <span>{task.groupName}</span>}
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
            {task.links.length > 0 && <LinkIcon className="size-4" aria-label="Has links" />}
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
      </motion.div>
    </div>
  );
}
