import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import ArrowUp from '~icons/material-symbols/arrow-upward-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Event from '~icons/material-symbols/event-outline-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import History from '~icons/material-symbols/history-rounded';
import Lock from '~icons/material-symbols/lock-outline-rounded';
import More from '~icons/material-symbols/more-vert';
import LinkIcon from '~icons/material-symbols/open-in-new-rounded';
import RestartAlt from '~icons/material-symbols/restart-alt-rounded';
import Store from '~icons/material-symbols/storefront-outline-rounded';
import { guessAisle } from '../../../shared/aisles.ts';
import { listSections, listTemplate, tripTitle, weekFrom, type ListTemplate } from '../../../shared/templates.ts';
import { GroupSheet } from '../components/GroupSheet.tsx';
import { GroupIcon, tone } from '../components/icons.tsx';
import { ItemSheet, ListMenu, SectionsSheet } from '../components/ListSheets.tsx';
import { DaySheet } from '../components/MoveSheet.tsx';
import { BackButton, Checkbox, Chip, ScrollRow, useBack } from '../components/ui.tsx';
import { ApiError, type ListItem } from '../lib/api.ts';
import { dayLabel, todayIso } from '../lib/dates.ts';
import { addListItem, checkListItem, editListItem, resetListItems } from '../lib/local.ts';
import { expressive } from '../lib/motion.ts';
import { useSend, useTaskActions } from '../lib/mutations.ts';
import { useGroups, useList, useListHistory, useTasks } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

/** The + in the toolbar, on a list page, adds to the list instead of opening quick add. */
export const ADD_TO_LIST = 'amble:add-to-list';

// How long a press has to last to open an item instead of checking it off, and how far the finger
// can drift before it counts as a scroll.
const HOLD_MS = 450;
const SLOP = 8;

/** ISO weekday (1 is Monday) of a YYYY-MM-DD date. */
function isoWeekday(iso: string) {
  const d = new Date(`${iso}T12:00:00`).getDay();
  return d === 0 ? 7 : d;
}

/** One item. Tap anywhere to check it off; hold (or right-click) to open it. */
function ItemRow({ item, template, showStore, onCheck, onOpen }: { item: ListItem; template: ListTemplate; showStore: boolean; onCheck: () => void; onOpen: () => void }) {
  const [ticked, setTicked] = useState(false);
  const press = useRef<{ timer?: ReturnType<typeof setTimeout>; held: boolean; x: number; y: number }>({ held: false, x: 0, y: 0 });
  const tick = () => {
    if (ticked) return;
    setTicked(true);
    // Let the check draw before the row leaves.
    setTimeout(onCheck, 280);
  };
  const open = () => {
    press.current.held = true;
    clearTimeout(press.current.timer);
    navigator.vibrate?.(10);
    onOpen();
  };
  const details = [
    item.price,
    showStore && item.store,
    template.fields.parts && item.parts?.length ? `${item.parts.length} ingredient${item.parts.length === 1 ? '' : 's'}` : null,
    item.note,
  ].filter(Boolean);

  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: 48, transition: { duration: 0.18 } }}
      transition={expressive.defaultSpatial}
    >
      <div
        role="button"
        tabIndex={0}
        aria-label={`${item.name}${item.quantity ? `, ${item.quantity}` : ''}. Tap to check off, hold to change`}
        onPointerDown={(e) => {
          press.current = { held: false, x: e.clientX, y: e.clientY, timer: setTimeout(open, HOLD_MS) };
        }}
        onPointerMove={(e) => {
          if (Math.abs(e.clientX - press.current.x) + Math.abs(e.clientY - press.current.y) > SLOP) clearTimeout(press.current.timer);
        }}
        onPointerUp={() => clearTimeout(press.current.timer)}
        onPointerCancel={() => clearTimeout(press.current.timer)}
        onClick={() => !press.current.held && tick()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            tick();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!press.current.held) open();
        }}
        className="press-soft state-layer flex min-h-14 cursor-pointer touch-pan-y items-center gap-3 rounded-3xl bg-surface-low px-4 py-2.5 select-none"
      >
        <Checkbox checked={ticked} label={`Check off ${item.name}`} onChange={() => !press.current.held && tick()} />
        <span className="min-w-0 flex-1">
          <span className={`block leading-snug transition-colors ${ticked ? 'text-on-surface-variant line-through' : ''}`}>{item.name}</span>
          {details.length > 0 && <span className="block truncate text-sm text-on-surface-variant">{details.join(' · ')}</span>}
        </span>
        {item.quantity && <span className="shrink-0 rounded-full bg-surface-high px-3 py-1 text-sm">{item.quantity}</span>}
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Open the link for ${item.name}`}
            className="-mr-1 grid size-10 shrink-0 place-items-center rounded-full text-primary hover:bg-surface-high"
          >
            <LinkIcon className="size-5" aria-hidden />
          </a>
        )}
      </div>
    </motion.li>
  );
}

export function ListPage({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const send = useSend();
  const actions = useTaskActions();
  const goBack = useBack('/backlog');
  const { data, error } = useList(groupId);
  const { data: history = [] } = useListHistory(groupId);
  const { data: groups = [] } = useGroups();
  const { data: openTasks = [] } = useTasks();
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  // The section new items go into, picked with a section's + until it's cleared.
  const [target, setTarget] = useState<string | null>(null);
  const [store, setStore] = useState<string | null>(null);
  const [showChecked, setShowChecked] = useState(false);
  const [editing, setEditing] = useState<ListItem | null>(null);
  const [sheet, setSheet] = useState<'menu' | 'sections' | 'edit' | 'trip' | 'look' | null>(null);

  const group = data?.group;
  const template = listTemplate(group?.template);
  const today = todayIso();
  const open = data?.open ?? [];
  const checked = data?.checked ?? [];
  const days = !!template.sections?.days;
  const noneLabel = template.sections?.none ?? 'Other';
  const sectionLabel = template.sections?.label ?? 'Section';
  const order = useMemo(
    () => (!group ? [] : days ? weekFrom(isoWeekday(today)) : listSections(group, open.map((i) => i.section))),
    [group, days, today, open],
  );
  const stores = useMemo(() => [...new Set([...open, ...checked].map((i) => i.store).filter((s): s is string => !!s))].sort(), [open, checked]);
  const trip = openTasks.find((t) => t.listId === groupId && t.status === 'open');
  const title = group ? tripTitle(group) : null;
  // Where a meal's ingredients go: the household's groceries list.
  const sendTo = template.fields.parts ? (groups.find((g) => g.kind === 'list' && g.template === 'groceries') ?? null) : null;

  // A store filter or a section being added to lets go once that store or section is gone (edited
  // away, renamed, removed), rather than hiding items or sending new ones somewhere unseen.
  useEffect(() => {
    if (store && !stores.includes(store)) setStore(null);
  }, [store, stores]);
  useEffect(() => {
    if (target && !order.includes(target)) setTarget(null);
  }, [target, order]);
  // A day's name, the way its section shows it: today and tomorrow by those words.
  const dayName = (section: string) => (days ? (['Today', 'Tomorrow'][order.indexOf(section)] ?? section) : section);

  useEffect(() => {
    const focus = () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      input.current?.focus();
    };
    window.addEventListener(ADD_TO_LIST, focus);
    return () => window.removeEventListener(ADD_TO_LIST, focus);
  }, []);

  // Each change shows at once and is kept on this device, so the list works in a store with no signal.
  const add = (item: { name: string; quantity?: string | null; section?: string | null; store?: string | null }) => {
    const id = crypto.randomUUID();
    const outcome = addListItem(qc, groupId, { id, ...item });
    if (outcome !== 'added') snack({ message: `${item.name} is ${outcome}` });
    send('POST', `/lists/${groupId}/items`, { id, ...item }, `Add ${item.name}`);
  };
  const check = (item: ListItem, on: boolean) => {
    checkListItem(qc, groupId, item.id, on);
    send('POST', `/lists/${groupId}/items/${item.id}/check`, { checked: on }, `${on ? 'Check off' : 'Put back'} ${item.name}`);
  };
  const edit = (item: ListItem, patch: Partial<ListItem>) => {
    editListItem(qc, groupId, item.id, patch);
    send('PATCH', `/lists/${groupId}/items/${item.id}`, patch, `Change ${item.name}`);
  };
  const reset = () => {
    const n = resetListItems(qc, groupId);
    snack({ message: n ? `${n} ${n === 1 ? 'item is' : 'items are'} back on the list` : 'Everything was already on the list' });
    send('POST', `/lists/${groupId}/reset`, {}, `Reset ${group?.name ?? 'the list'}`);
  };
  const planTrip = (date: string | null) => {
    if (!group || !title) return;
    const errands = groups.find((g) => g.kind === 'tasks' && g.name.toLowerCase() === 'errands');
    actions.create({ title, listId: group.id, groupId: errands?.id ?? null, plannedDate: date, estimateMinutes: template.trip?.minutes ?? null });
    snack({ message: date ? `${title} planned for ${dayLabel(date, today, true)}` : `${title} is in the backlog` });
  };

  // Things bought before that match what's being typed, and aren't on the list now.
  const q = name.trim().toLowerCase();
  const suggestions = useMemo(
    () => (q ? history.filter((h) => !h.onList && h.name.toLowerCase().includes(q) && h.name.toLowerCase() !== q).slice(0, 6) : []),
    [q, history],
  );
  const addItem = (item: { name: string; quantity?: string | null }) => {
    // The section someone picked, else where it went last time, else a guess from its name.
    const known = history.find((h) => h.name.toLowerCase() === item.name.toLowerCase());
    const section = target ?? known?.section ?? guessAisle(item.name, order);
    add({ ...item, section, ...(store && { store }) });
    setName('');
    setQuantity('');
    input.current?.focus();
  };

  const sections = useMemo(() => {
    const shown = store ? open.filter((i) => !i.store || i.store === store) : open;
    if (order.length === 0) return [{ name: null as string | null, label: null as string | null, items: shown }];
    const by = new Map<string, ListItem[]>();
    const none: ListItem[] = [];
    for (const item of shown) {
      const key = item.section && item.section.toLowerCase() !== noneLabel.toLowerCase() ? order.find((s) => s.toLowerCase() === item.section!.toLowerCase()) : undefined;
      if (key) by.set(key, [...(by.get(key) ?? []), item]);
      else none.push(item);
    }
    const out = order
      .map((s, i) => ({ name: s as string | null, label: days && i < 2 ? (i === 0 ? 'Today' : 'Tomorrow') : s, items: by.get(s) ?? [] }))
      .filter((s) => days || s.items.length > 0);
    if (none.length) out.push({ name: null, label: noneLabel, items: none });
    return out;
  }, [open, order, store, days, noneLabel]);

  const share = () => {
    if (!group) return;
    const lines = [group.name];
    for (const s of sections) {
      if (s.items.length === 0) continue;
      if (s.label) lines.push('', s.label);
      for (const i of s.items) lines.push(`- ${i.name}${i.quantity ? ` (${i.quantity})` : ''}`);
    }
    const text = lines.join('\n');
    if (navigator.share) navigator.share({ title: group.name, text }).catch(() => {});
    else void navigator.clipboard.writeText(text).then(() => snack({ message: 'Copied the list' }));
  };

  // Archived, made private by someone else, or never opened here while offline.
  if (!data && error) {
    return (
      <>
        <BackButton onClick={goBack} />
        <p className="mt-10 text-center text-on-surface-variant">
          {error instanceof ApiError && error.status === 0 ? "You're offline, and this list hasn't been opened on this device yet." : "That list isn't here anymore."}
        </p>
      </>
    );
  }

  const placeholder = !target
    ? template.placeholder
    : days
      ? `${template.placeholder} for ${order.indexOf(target) < 2 ? dayName(target).toLowerCase() : target}`
      : `${template.placeholder} to ${target}`;

  return (
    <>
      <header className="flex items-center gap-2">
        <BackButton onClick={goBack} />
        {group && (
          <>
            <span className={`grid size-11 shrink-0 place-items-center rounded-[1.1rem] ${tone(group.color)}`}>
              <GroupIcon name={group.icon} className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="display truncate text-[1.625rem] leading-tight font-medium">{group.name}</h1>
              <p className="flex items-center gap-1 text-sm text-on-surface-variant">
                {group.privateTo && <Lock className="size-3.5" aria-label="Only you can see it" />}
                {open.length ? `${open.length} on the list` : 'Nothing on the list'}
              </p>
            </div>
            <button type="button" aria-label="List options" onClick={() => setSheet('menu')} className="-mr-2 grid size-12 shrink-0 place-items-center rounded-full hover:bg-surface-high">
              <More className="size-6" aria-hidden />
            </button>
          </>
        )}
      </header>

      {group && (title || template.resettable || stores.length > 0) && (
        <ScrollRow className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4" aria-label="List actions">
          {title &&
            (trip ? (
              <Link
                to="/task/$taskId"
                params={{ taskId: trip.id }}
                className="chip chip-on border-transparent bg-tertiary-container text-on-tertiary-container"
              >
                <Event aria-hidden />
                {trip.title} · {trip.plannedDate ? dayLabel(trip.plannedDate, today) : 'no day yet'}
              </Link>
            ) : (
              <Chip onClick={() => setSheet('trip')} icon={<Event />}>
                Plan the {title.toLowerCase()}
              </Chip>
            ))}
          {template.resettable && (
            <Chip onClick={reset} icon={<RestartAlt />}>
              Start over
            </Chip>
          )}
          {stores.map((s) => (
            <Chip key={s} selected={store === s} onClick={() => setStore(store === s ? null : s)} icon={<Store />}>
              {s}
            </Chip>
          ))}
        </ScrollRow>
      )}

      <form
        className="mt-4 flex h-14 items-center gap-1 rounded-full bg-surface-high pr-1.5 pl-2 transition-shadow focus-within:ring-2 focus-within:ring-primary"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) addItem({ name: name.trim(), quantity: quantity.trim() || null });
        }}
      >
        {target ? (
          <button
            type="button"
            onClick={() => setTarget(null)}
            aria-label={`Stop adding to ${dayName(target)}`}
            className="flex h-9 max-w-[40%] shrink-0 items-center gap-1 rounded-full bg-secondary-container pr-2 pl-3 text-sm text-on-secondary-container"
          >
            <span className="truncate">{dayName(target)}</span>
            <Close className="size-4 shrink-0" aria-hidden />
          </button>
        ) : (
          <Add className="mx-1.5 size-6 shrink-0 text-on-surface-variant" aria-hidden />
        )}
        <input
          ref={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={placeholder}
          aria-label="Item"
          enterKeyHint="enter"
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent px-1.5 outline-none placeholder:text-on-surface-variant"
        />
        {template.fields.quantity && (
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Qty"
            aria-label="Quantity"
            className="h-9 w-14 shrink-0 rounded-full bg-surface-highest text-center text-sm outline-none placeholder:text-on-surface-variant"
          />
        )}
        <button
          type="submit"
          aria-label="Add item"
          disabled={!name.trim()}
          className={`press grid size-11 shrink-0 place-items-center rounded-full transition-colors ${name.trim() ? 'bg-primary text-on-primary' : 'text-on-surface-variant'}`}
        >
          <ArrowUp className="size-6" aria-hidden />
        </button>
      </form>
      <AnimatePresence initial={false}>
        {suggestions.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <ScrollRow className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-2.5" aria-label="Had before">
              {suggestions.map((s) => (
                <Chip key={s.name} onClick={() => addItem({ name: s.name, quantity: quantity.trim() || s.quantity })} icon={<History />}>
                  {s.name}
                </Chip>
              ))}
            </ScrollRow>
          </motion.div>
        )}
      </AnimatePresence>

      {sections.map((section) => (
        <section key={section.label ?? 'all'} aria-label={section.label ?? undefined}>
          {section.label ? (
            <div className="mt-6 mb-2 flex items-center justify-between pl-1">
              <h2 className={`text-sm font-medium ${days && section.items.length === 0 ? 'text-on-surface-variant' : 'text-primary'}`}>{section.label}</h2>
              {section.name && (section.items.length > 0 || !days) && (
                <button
                  type="button"
                  onClick={() => {
                    setTarget(section.name);
                    input.current?.focus();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  aria-label={`Add to ${section.label}`}
                  className="-my-2 grid size-10 place-items-center rounded-full text-on-surface-variant hover:bg-surface-high"
                >
                  <Add className="size-5" aria-hidden />
                </button>
              )}
            </div>
          ) : (
            <div className="h-4" />
          )}
          {days && section.name && section.items.length === 0 && (
            <button
              type="button"
              onClick={() => {
                setTarget(section.name);
                input.current?.focus();
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
              className="press-soft flex h-12 w-full items-center gap-2 rounded-3xl border border-dashed border-outline-variant px-4 text-sm text-on-surface-variant"
            >
              <Add className="size-5" aria-hidden />
              {template.placeholder}
            </button>
          )}
          <ul className="flex flex-col gap-1.5">
            <AnimatePresence initial={false}>
              {section.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  template={template}
                  showStore={!store}
                  onCheck={() => check(item, true)}
                  onOpen={() => {
                    setEditing(item);
                    setSheet('edit');
                  }}
                />
              ))}
            </AnimatePresence>
          </ul>
        </section>
      ))}
      {data && open.length === 0 && !days && <p className="mt-8 text-center text-on-surface-variant">All clear. Nothing on the list.</p>}
      {data && open.length > 0 && <p className="mt-5 text-center text-xs text-on-surface-variant">Tap to check off. Hold to change.</p>}

      {checked.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowChecked((v) => !v)}
            aria-expanded={showChecked}
            className="mt-6 mb-2 flex w-full items-center justify-between px-1 text-sm font-medium text-primary"
          >
            {template.checked} · tap to add again
            <motion.span animate={{ rotate: showChecked ? 180 : 0 }} transition={expressive.fastSpatial}>
              <ExpandMore className="size-5" aria-hidden />
            </motion.span>
          </button>
          <AnimatePresence initial={false}>
            {showChecked && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={expressive.defaultSpatial}
                className="flex flex-wrap gap-2 overflow-hidden"
              >
                {checked.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => check(item, false)}
                    className="chip"
                  >
                    {item.name}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      <ItemSheet
        item={sheet === 'edit' ? editing : null}
        template={template}
        sections={order}
        stores={stores}
        sendTo={sendTo}
        onClose={() => setSheet(null)}
        onSave={(patch) => editing && edit(editing, patch)}
      />
      {group && (
        <>
          <ListMenu
            open={sheet === 'menu'}
            sectionsLabel={days ? null : sectionLabel}
            onClose={() => setSheet(null)}
            onSections={() => setSheet('sections')}
            onShare={share}
            onEdit={() => setSheet('look')}
          />
          <SectionsSheet open={sheet === 'sections'} group={group} label={sectionLabel} used={open.map((i) => i.section)} onClose={() => setSheet(null)} />
          {title && <DaySheet open={sheet === 'trip'} verb="Plan" title={title} today={today} onPick={planTrip} onClose={() => setSheet(null)} />}
          <GroupSheet open={sheet === 'look'} group={{ ...group, open: open.length }} onClose={() => setSheet(null)} />
        </>
      )}
    </>
  );
}
