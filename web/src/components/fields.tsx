// Chip pickers for a task's fields, shared by quick add and the smart add review cards.
import type { ReactNode } from 'react';
import Event from '~icons/material-symbols/event-outline-rounded';
import Flag from '~icons/material-symbols/flag-rounded';
import type { Group, HouseholdMember, TimeOfDay } from '../lib/api.ts';
import { addDays, dayLabel, firstName } from '../lib/dates.ts';
import { GroupIcon } from './icons.tsx';
import { Chip, ScrollRow } from './ui.tsx';

/** A row of chips that scrolls sideways, edge to edge inside a sheet (or a card, with `tight`). */
export function ChipRow({ label, children, tight }: { label?: string; children: ReactNode; tight?: boolean }) {
  return (
    <div className="mt-2.5">
      {label && <p className="mb-1.5 px-1 text-xs text-on-surface-variant">{label}</p>}
      <ScrollRow className={`flex gap-2 overflow-x-auto pb-1 ${tight ? '-mx-3 px-3' : '-mx-5 px-5'}`}>{children}</ScrollRow>
    </div>
  );
}

/** A chip that opens the date picker. */
export function DateChip({
  value,
  label,
  onPick,
  min,
  keepFocus,
}: {
  value: string | null;
  label: string;
  onPick: (d: string | null) => void;
  min?: string;
  keepFocus?: boolean;
}) {
  return (
    <label
      onPointerDown={keepFocus ? (e) => e.preventDefault() : undefined}
      className={`chip cursor-pointer ${value ? 'chip-on' : ''}`}
    >
      <Event aria-hidden />
      {label}
      <input
        type="date"
        min={min}
        value={value ?? ''}
        onChange={(e) => onPick(e.target.value || null)}
        onClick={(e) => (e.target as HTMLInputElement).showPicker?.()}
        className="absolute inset-0 opacity-0"
        aria-label={label}
      />
    </label>
  );
}

export function WhenChips({ value, today, onChange }: { value: string | null; today: string; onChange: (d: string | null) => void }) {
  const later = value && value > addDays(today, 1) ? value : null;
  return (
    <>
      <Chip selected={value === null} onClick={() => onChange(null)}>
        Someday
      </Chip>
      <Chip selected={value === today} onClick={() => onChange(today)}>
        Today
      </Chip>
      <Chip selected={value === addDays(today, 1)} onClick={() => onChange(addDays(today, 1))}>
        Tomorrow
      </Chip>
      <DateChip value={later} min={today} label={later ? dayLabel(later, today) : 'Pick a day'} onPick={onChange} />
    </>
  );
}

export function GroupChips({ groups, value, onChange }: { groups: Group[]; value: string | null; onChange: (id: string | null) => void }) {
  return (
    <>
      <Chip selected={value === null} onClick={() => onChange(null)}>
        No group
      </Chip>
      {groups
        .filter((g) => g.kind === 'tasks')
        .map((g) => (
          <Chip key={g.id} selected={value === g.id} onClick={() => onChange(g.id)} icon={<GroupIcon name={g.icon} className="size-4" />}>
            {g.name}
          </Chip>
        ))}
    </>
  );
}

/** Who it's for. `value` undefined means "me" where the field allows leaving it out. */
export function PersonChips({
  members,
  me,
  value,
  onChange,
}: {
  members: HouseholdMember[];
  me: string;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <>
      <Chip selected={value === me} onClick={() => onChange(me)}>
        Me
      </Chip>
      {members
        .filter((m) => m.id !== me)
        .map((m) => (
          <Chip key={m.id} selected={value === m.id} onClick={() => onChange(m.id)}>
            {firstName(m.name)}
          </Chip>
        ))}
      <Chip selected={value === null} onClick={() => onChange(null)}>
        Anyone
      </Chip>
    </>
  );
}

export function TimeChips({ value, onChange }: { value: TimeOfDay | null; onChange: (t: TimeOfDay | null) => void }) {
  return (
    <>
      <Chip selected={value === null} onClick={() => onChange(null)}>
        Any time
      </Chip>
      {(['morning', 'afternoon', 'evening'] as const).map((t) => (
        <Chip key={t} selected={value === t} onClick={() => onChange(t)}>
          <span className="capitalize">{t}</span>
        </Chip>
      ))}
    </>
  );
}

export function MustDoChip({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Chip selected={value} onClick={() => onChange(!value)} icon={<Flag />}>
      Must do
    </Chip>
  );
}

export const ESTIMATES = [5, 10, 15, 30, 45, 60, 90, 120, 180];

export function estimateLabel(m: number) {
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60}` : `${m / 60} h`;
}

export function EstimateChips({ value, onChange }: { value: number | null; onChange: (m: number | null) => void }) {
  const options = value && !ESTIMATES.includes(value) ? [...ESTIMATES, value].sort((a, b) => a - b) : ESTIMATES;
  return (
    <>
      {options.map((m) => (
        <Chip key={m} selected={value === m} onClick={() => onChange(value === m ? null : m)}>
          {estimateLabel(m)}
        </Chip>
      ))}
    </>
  );
}
