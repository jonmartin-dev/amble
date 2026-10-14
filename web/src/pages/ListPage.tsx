import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import { GroupIcon, tone } from '../components/icons.tsx';
import { Checkbox } from '../components/ui.tsx';
import { api, type ListItem } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useList } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

export function ListPage({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data } = useList(groupId);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['list', groupId] });
    void qc.invalidateQueries({ queryKey: ['groups'] });
  };

  const add = useMutation({
    mutationFn: (item: { name: string; quantity?: string }) =>
      api<{ outcome: string }>(`/lists/${groupId}/items`, { method: 'POST', body: JSON.stringify(item) }),
    onSuccess: (r, item) => r.outcome !== 'added' && snack({ message: `${item.name} is ${r.outcome}` }),
    onSettled: refresh,
  });
  const check = useMutation({
    mutationFn: ({ item, checked }: { item: ListItem; checked: boolean }) =>
      api(`/lists/${groupId}/items/${item.id}/check`, { method: 'POST', body: JSON.stringify({ checked }) }),
    onSettled: refresh,
  });

  const group = data?.group;

  return (
    <>
      <header className="mb-4 flex items-center gap-2">
        <Link to="/backlog" aria-label="Back" className="-ml-2 grid size-12 place-items-center rounded-full hover:bg-surface-high">
          <ArrowBack className="size-6" aria-hidden />
        </Link>
        {group && (
          <>
            <span className={`grid size-10 place-items-center rounded-2xl ${tone(group.color)}`}>
              <GroupIcon name={group.icon} className="size-5" />
            </span>
            <h1 className="display text-[1.75rem] font-medium">{group.name}</h1>
          </>
        )}
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          add.mutate({ name: name.trim(), ...(quantity.trim() && { quantity: quantity.trim() }) });
          setName('');
          setQuantity('');
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add an item"
          aria-label="Item"
          enterKeyHint="done"
          className="min-w-0 flex-1 rounded-2xl bg-surface-high px-4 py-3.5 outline-none placeholder:text-on-surface-variant"
        />
        <input
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="Qty"
          aria-label="Quantity"
          className="w-16 rounded-2xl bg-surface-high px-3 py-3.5 text-center outline-none placeholder:text-on-surface-variant"
        />
        <motion.button
          type="submit"
          whileTap={{ scale: 0.9 }}
          aria-label="Add item"
          className="grid size-[3.25rem] shrink-0 place-items-center rounded-2xl bg-primary text-on-primary"
        >
          <Add className="size-6" aria-hidden />
        </motion.button>
      </form>

      <ul className="mt-4 flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {data?.open.map((item) => (
            <motion.li
              key={item.id}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: 40 }}
              transition={expressive.defaultSpatial}
              className="flex items-center gap-3 rounded-3xl bg-surface-low px-4 py-3"
            >
              <Checkbox checked={false} label={`Got ${item.name}`} onChange={() => setTimeout(() => check.mutate({ item, checked: true }), 250)} />
              <span className="flex-1">
                {item.name}
                {item.note && <span className="block text-sm text-on-surface-variant">{item.note}</span>}
              </span>
              {item.quantity && <span className="rounded-full bg-surface-high px-3 py-1 text-sm">{item.quantity}</span>}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      {data && data.open.length === 0 && <p className="mt-6 text-center text-on-surface-variant">All clear. Nothing on the list.</p>}

      {data && data.checked.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowChecked((v) => !v)}
            aria-expanded={showChecked}
            className="mt-7 mb-2 flex w-full items-center justify-between px-1 text-sm font-medium text-primary"
          >
            Recently got · tap to add again
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
                {data.checked.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => check.mutate({ item, checked: false })}
                    className="rounded-full border border-outline-variant px-4 py-2 text-sm text-on-surface-variant"
                  >
                    {item.name}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </>
  );
}
