import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Archive from '~icons/material-symbols/archive-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import { LIST_TEMPLATES, listTemplate, type ListTemplate } from '../../../shared/templates.ts';
import { api, type Group } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { ChipRow } from './fields.tsx';
import { GROUP_ICON_NAMES, GroupIcon, tone } from './icons.tsx';
import { ButtonGroup, Chip, Sheet, Switch } from './ui.tsx';

const colors = ['green', 'teal', 'lime', 'blue', 'violet', 'orange', 'rose'];

/** Make a group or list, or, given one, rename, recolor or archive it. */
export function GroupSheet({ open, onClose, group }: { open: boolean; onClose: () => void; group?: Group | null }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const editing = group != null;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'tasks' | 'list'>('tasks');
  const [color, setColor] = useState('blue');
  const [icon, setIcon] = useState('folder');
  const [isPrivate, setPrivate] = useState(false);
  const [template, setTemplate] = useState('default');
  // The starter kit's name, or null for an empty list.
  const [kit, setKit] = useState<string | null>(null);
  // Whether the name is still the template's, so picking another template can replace it.
  const [named, setNamed] = useState(false);
  const [showLook, setShowLook] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setKind(group?.kind ?? 'tasks');
    setColor(group?.color ?? 'blue');
    setIcon(group?.icon ?? 'folder');
    setPrivate(group?.privateTo != null);
    setTemplate('default');
    setKit(null);
    setNamed(false);
    setShowLook(editing);
    // Only when it opens or turns to another group: the list page hands over a fresh copy each
    // time it draws, and that mustn't undo what's being typed.
  }, [open, group?.id]);

  // A template brings its own look, name, kit and privacy; the person can still change them.
  const pickTemplate = (t: ListTemplate) => {
    setTemplate(t.id);
    setIcon(t.icon);
    if (t.id !== 'default') setColor(t.color);
    if (!name.trim() || !named) setName(t.id === 'default' ? '' : t.name);
    setKit(t.kits?.[0]?.name ?? null);
    setPrivate(!!t.private);
  };

  const refresh = () => {
    for (const key of ['groups', 'tasks', 'today', 'activity', 'stats']) void qc.invalidateQueries({ queryKey: [key] });
  };
  const onError = (e: Error) => snack({ message: e.message });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api(`/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify({ name, icon, color }) })
        : api('/groups', {
            method: 'POST',
            body: JSON.stringify({ name, kind, color, icon, private: isPrivate, ...(kind === 'list' && { template, kit }) }),
          }),
    onSuccess: () => {
      snack({ message: editing ? `Saved ${name}` : `Made ${name}` });
      onClose();
    },
    onError,
    onSettled: refresh,
  });

  const archive = useMutation({
    mutationFn: (g: Group) => api(`/groups/${g.id}/archive`, { method: 'POST', body: '{}' }),
    onSuccess: (_, g) => {
      const moved = g.kind === 'tasks' && g.open > 0 ? ` Its ${g.open} open ${g.open === 1 ? 'task is' : 'tasks are'} in No group now.` : '';
      snack({
        message: `Archived ${g.name}.${moved}`,
        action: {
          label: 'Undo',
          run: () => void api(`/groups/${g.id}/archive`, { method: 'POST', body: JSON.stringify({ restore: true }) }).then(refresh, onError),
        },
      });
      onClose();
    },
    onError,
    onSettled: refresh,
  });

  const noun = kind === 'list' ? 'list' : 'group';
  const picked = listTemplate(template);
  const look = (
    <>
      <div className="mt-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icon">
        {GROUP_ICON_NAMES.map((i) => (
          <motion.button
            key={i}
            type="button"
            role="radio"
            aria-checked={icon === i}
            aria-label={i}
            onClick={() => setIcon(i)}
            animate={{ borderRadius: icon === i ? 14 : 999 }}
            transition={expressive.fastSpatial}
            className={`grid size-10 place-items-center ${icon === i ? tone(color) : 'bg-surface-high text-on-surface-variant'}`}
          >
            <GroupIcon name={i} className="size-5" />
          </motion.button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
        {colors.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} onClick={() => setColor(c)} className={`grid size-10 place-items-center rounded-full ${tone(c)}`}>
            {color === c && <Check className="size-5" aria-hidden />}
          </button>
        ))}
      </div>
    </>
  );

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={editing ? `Edit ${noun}` : 'New group or list'}
      header={<p className="display pb-1 text-2xl font-medium">{editing ? `Edit ${noun}` : `New ${noun}`}</p>}
      footer={
        <>
          <button
            type="submit"
            form="group-form"
            disabled={!name.trim() || save.isPending}
            className="press h-12 w-full rounded-full bg-primary font-medium text-on-primary disabled:opacity-50"
          >
            {editing ? 'Save' : 'Create'}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => archive.mutate(group)}
              disabled={archive.isPending}
              className="mt-1 flex h-12 w-full items-center justify-center gap-2 rounded-full font-medium text-error hover:bg-surface-high"
            >
              <Archive className="size-5" aria-hidden />
              Archive {noun}
            </button>
          )}
        </>
      }
    >
      <form
        id="group-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        {!editing && (
          <div className="mt-1">
            <ButtonGroup
              label="Kind"
              size="sm"
              value={kind}
              options={[
                { value: 'tasks', label: 'Task group' },
                { value: 'list', label: 'List' },
              ]}
              onChange={(k) => {
                setKind(k);
                if (k === 'list') pickTemplate(picked);
                else {
                  setIcon('folder');
                  setPrivate(false);
                  if (!named) setName('');
                }
              }}
            />
          </div>
        )}
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setNamed(true);
          }}
          placeholder={kind === 'list' ? 'Name the list' : 'Garden, Car, Taxes…'}
          aria-label="Name"
          className="mt-3 w-full rounded-2xl bg-surface-high px-4 py-3.5 text-lg outline-none placeholder:text-on-surface-variant"
        />

        {!editing && kind === 'list' && (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Kind of list">
              {LIST_TEMPLATES.map((t) => {
                const on = template === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => pickTemplate(t)}
                    className={`press flex flex-col items-center gap-1.5 rounded-3xl px-1 pt-3 pb-2.5 text-center transition-colors ${
                      on ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-high'
                    }`}
                  >
                    <motion.span
                      animate={{ borderRadius: on ? 14 : 999 }}
                      transition={expressive.fastSpatial}
                      className={`grid size-10 place-items-center ${tone(t.id === 'default' ? color : t.color)}`}
                    >
                      {on ? <Check className="size-5" aria-hidden /> : <GroupIcon name={t.icon} className="size-5" />}
                    </motion.span>
                    <span className="text-[0.8125rem] leading-tight font-medium">{t.name}</span>
                  </button>
                );
              })}
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.p
                key={picked.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={expressive.fastSpatial}
                className="mt-3 px-1 text-sm text-on-surface-variant"
              >
                {picked.description}
              </motion.p>
            </AnimatePresence>
            {picked.kits && (
              <ChipRow label="Start with">
                {picked.kits.map((k) => (
                  <Chip key={k.name} selected={kit === k.name} onClick={() => setKit(k.name)}>
                    {k.name}
                  </Chip>
                ))}
                <Chip selected={kit === null} onClick={() => setKit(null)}>
                  Nothing
                </Chip>
              </ChipRow>
            )}
          </>
        )}

        {!editing && (
          <div className="mt-4 flex items-center gap-3 rounded-3xl bg-surface-high px-4 py-3">
            <span className="min-w-0 flex-1">
              <span className="block">Only me</span>
              <span className="block text-sm text-on-surface-variant">
                {kind === 'list' && picked.private ? 'Gift ideas start private, so nobody sees their own' : `Nobody else sees this ${noun}`}
              </span>
            </span>
            <Switch checked={isPrivate} onChange={setPrivate} label="Only me" />
          </div>
        )}

        {editing || kind === 'tasks' ? (
          look
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowLook((v) => !v)}
              aria-expanded={showLook}
              className="mt-3 flex w-full items-center gap-3 rounded-full py-2 pr-2 pl-1 text-sm font-medium text-primary"
            >
              <span className={`grid size-8 place-items-center rounded-xl ${tone(color)}`}>
                <GroupIcon name={icon} className="size-4" />
              </span>
              <span className="flex-1 text-left">Change the icon or color</span>
              <motion.span animate={{ rotate: showLook ? 180 : 0 }} transition={expressive.fastSpatial}>
                <ExpandMore className="size-5" aria-hidden />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {showLook && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={expressive.fastSpatial} className="overflow-hidden">
                  {look}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
        <div className="h-2" />
      </form>
    </Sheet>
  );
}
