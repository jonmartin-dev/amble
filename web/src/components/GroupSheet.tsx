import { useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Archive from '~icons/material-symbols/archive-outline-rounded';
import Check from '~icons/material-symbols/check-rounded';
import { api, type Group } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { GroupIcon, tone } from './icons.tsx';
import { LIST_TEMPLATES, type ListTemplate } from '../../../shared/templates.ts';
import { Chip, Sheet } from './ui.tsx';

const colors = ['green', 'teal', 'lime', 'blue', 'violet', 'orange', 'rose'];
const icons = ['folder', 'home', 'directions-car', 'call', 'rocket-launch', 'palette', 'shopping-cart', 'shopping-bag', 'luggage', 'checklist'];

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

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setKind(group?.kind ?? 'tasks');
    setColor(group?.color ?? 'blue');
    setIcon(group?.icon ?? 'folder');
    setPrivate(group?.privateTo != null);
    setTemplate('default');
  }, [open, group]);

  // A template brings its own look; the person can still change it.
  const pickTemplate = (t: ListTemplate) => {
    setTemplate(t.id);
    setIcon(t.icon);
    if (t.id !== 'default') setColor(t.color);
    if (!name.trim() && t.id !== 'default') setName(t.name);
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
            body: JSON.stringify({ name, kind, color, icon, private: isPrivate, ...(kind === 'list' && { template }) }),
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
          run: () =>
            void api(`/groups/${g.id}/archive`, { method: 'POST', body: JSON.stringify({ restore: true }) }).then(refresh, onError),
        },
      });
      onClose();
    },
    onError,
    onSettled: refresh,
  });

  const noun = kind === 'list' ? 'list' : 'group';

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
            className="h-12 w-full rounded-full bg-primary font-medium text-on-primary disabled:opacity-50"
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
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'list' ? 'Packing, Hardware store…' : 'Garden, Car, Taxes…'}
          aria-label="Name"
          className="mt-2 w-full rounded-2xl bg-surface-high px-4 py-3.5 text-lg outline-none placeholder:text-on-surface-variant"
        />
        {!editing && (
          <div className="mt-4 flex gap-2">
            <Chip selected={kind === 'tasks'} onClick={() => setKind('tasks')}>
              Tasks
            </Chip>
            <Chip
              selected={kind === 'list'}
              onClick={() => {
                setKind('list');
                pickTemplate(LIST_TEMPLATES.find((t) => t.id === template) ?? LIST_TEMPLATES[0]!);
              }}
            >
              Shopping-style list
            </Chip>
            <Chip selected={isPrivate} onClick={() => setPrivate((v) => !v)}>
              Only me
            </Chip>
          </div>
        )}
        {!editing && kind === 'list' && (
          <div className="mt-4 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kind of list">
            {LIST_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={template === t.id}
                onClick={() => pickTemplate(t)}
                className={`rounded-3xl p-3 text-left transition-colors ${
                  template === t.id ? 'bg-secondary-container text-on-secondary-container ring-2 ring-primary' : 'bg-surface-high'
                }`}
              >
                <span className={`mb-2 grid size-9 place-items-center rounded-xl ${tone(t.id === 'default' ? color : t.color)}`}>
                  <GroupIcon name={t.icon} className="size-5" />
                </span>
                <span className="block font-medium">{t.name}</span>
                <span className="mt-0.5 block text-xs leading-snug opacity-80">{t.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className="mt-5 flex flex-wrap gap-2" role="radiogroup" aria-label="Icon">
          {icons.map((i) => (
            <motion.button
              key={i}
              type="button"
              role="radio"
              aria-checked={icon === i}
              aria-label={i}
              onClick={() => setIcon(i)}
              animate={{ borderRadius: icon === i ? 14 : 999 }}
              transition={expressive.fastSpatial}
              className={`grid size-11 place-items-center ${icon === i ? tone(color) : 'bg-surface-high text-on-surface-variant'}`}
            >
              <GroupIcon name={i} className="size-5" />
            </motion.button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Color">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
              className={`grid size-10 place-items-center rounded-full ${tone(c)}`}
            >
              {color === c && <Check className="size-5" aria-hidden />}
            </button>
          ))}
        </div>
        <div className="h-2" />
      </form>
    </Sheet>
  );
}
