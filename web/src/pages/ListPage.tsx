import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import History from '~icons/material-symbols/history-rounded';
import LinkIcon from '~icons/material-symbols/open-in-new-rounded';
import RestartAlt from '~icons/material-symbols/restart-alt-rounded';
import { listTemplate, type ListTemplate } from '../../../shared/templates.ts';
import { ChipRow } from '../components/fields.tsx';
import { GroupIcon, tone } from '../components/icons.tsx';
import { Checkbox, Chip, SectionTitle, Sheet } from '../components/ui.tsx';
import { type ListItem } from '../lib/api.ts';
import { addListItem, checkListItem, editListItem, resetListItems } from '../lib/local.ts';
import { expressive } from '../lib/motion.ts';
import { useSend } from '../lib/mutations.ts';
import { useList, useListHistory } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';

const OTHER = 'Other';
const fieldInput = 'w-full rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant';

/** Edit one item: name, amount, aisle, and a link and price on shopping lists. */
function ItemSheet({ item, template, onClose, onSave }: { item: ListItem | null; template: ListTemplate; onClose: () => void; onSave: (patch: Partial<ListItem>) => void }) {
  const [draft, setDraft] = useState<Partial<ListItem>>({});
  useEffect(() => setDraft(item ?? {}), [item]);
  const set = (patch: Partial<ListItem>) => setDraft((d) => ({ ...d, ...patch }));
  return (
    <Sheet
      open={item != null}
      onClose={onClose}
      label="Edit item"
      header={<p className="pb-1 text-lg font-medium">Edit item</p>}
      footer={
        <button
          type="button"
          disabled={!draft.name?.trim()}
          onClick={() => {
            onSave({ name: draft.name?.trim(), quantity: draft.quantity || null, note: draft.note || null, section: draft.section ?? null, url: draft.url || null, price: draft.price || null });
            onClose();
          }}
          className="h-12 w-full rounded-full bg-primary font-medium text-on-primary disabled:opacity-40"
        >
          Save
        </button>
      }
    >
      <div className="flex gap-2">
        <input value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} aria-label="Name" className={`${fieldInput} flex-[3]`} />
        {template.fields.quantity && (
          <input value={draft.quantity ?? ''} onChange={(e) => set({ quantity: e.target.value })} placeholder="Qty" aria-label="Quantity" className={`${fieldInput} flex-1`} />
        )}
      </div>
      {template.sections && (
        <ChipRow label={template.id === 'groceries' ? 'Aisle' : 'Section'}>
          {template.sections.map((s) => (
            <Chip key={s} selected={draft.section === s} onClick={() => set({ section: draft.section === s ? null : s })}>
              {s}
            </Chip>
          ))}
        </ChipRow>
      )}
      {template.fields.url && (
        <input value={draft.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="Link" inputMode="url" aria-label="Link" className={`${fieldInput} mt-3`} />
      )}
      {template.fields.price && (
        <input value={draft.price ?? ''} onChange={(e) => set({ price: e.target.value })} placeholder="Price" aria-label="Price" className={`${fieldInput} mt-3`} />
      )}
      <input value={draft.note ?? ''} onChange={(e) => set({ note: e.target.value })} placeholder="Note" aria-label="Note" className={`${fieldInput} mt-3 mb-2`} />
    </Sheet>
  );
}

export function ListPage({ groupId }: { groupId: string }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const { data } = useList(groupId);
  const { data: history = [] } = useListHistory(groupId);
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const [editing, setEditing] = useState<ListItem | null>(null);
  const send = useSend();

  const group = data?.group;
  const template = listTemplate(group?.template);

  // Each change shows at once and syncs through the outbox, so the list works in a store with no signal.
  const add = (item: { name: string; quantity?: string | null; section?: string | null }) => {
    const id = crypto.randomUUID();
    const outcome = addListItem(qc, groupId, { id, ...item });
    if (outcome !== 'added') snack({ message: `${item.name} is ${outcome}` });
    send('POST', `/lists/${groupId}/items`, { id, ...item }, `Add ${item.name}`);
  };
  const check = (item: ListItem, checked: boolean) => {
    checkListItem(qc, groupId, item.id, checked);
    send('POST', `/lists/${groupId}/items/${item.id}/check`, { checked }, `${checked ? 'Check off' : 'Put back'} ${item.name}`);
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

  // Things bought before that match what's being typed, and aren't on the list now.
  const q = name.trim().toLowerCase();
  const suggestions = useMemo(
    () => (q ? history.filter((h) => !h.onList && h.name.toLowerCase().includes(q) && h.name.toLowerCase() !== q).slice(0, 6) : []),
    [q, history],
  );
  const addItem = (item: { name: string; quantity?: string | null }) => {
    // Remembered aisles come back with the item.
    const known = history.find((h) => h.name.toLowerCase() === item.name.toLowerCase());
    add({ ...item, section: known?.section ?? null });
    setName('');
    setQuantity('');
  };

  const sections = useMemo(() => {
    const open = data?.open ?? [];
    if (!template.sections) return [{ name: null as string | null, items: open }];
    const order = [...template.sections, OTHER];
    const by = new Map<string, ListItem[]>();
    for (const item of open) {
      const key = item.section && template.sections.includes(item.section) ? item.section : OTHER;
      by.set(key, [...(by.get(key) ?? []), item]);
    }
    return order.filter((s) => by.has(s)).map((s) => ({ name: s as string | null, items: by.get(s)! }));
  }, [data?.open, template]);

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
            <h1 className="display min-w-0 flex-1 truncate text-[1.75rem] font-medium">{group.name}</h1>
            {template.resettable && (
              <button
                type="button"
                onClick={reset}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-high px-3.5 py-2 text-sm font-medium"
              >
                <RestartAlt className="size-5" aria-hidden />
                Reset
              </button>
            )}
          </>
        )}
      </header>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) addItem({ name: name.trim(), quantity: quantity.trim() || null });
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Add an item"
          aria-label="Item"
          enterKeyHint="done"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-2xl bg-surface-high px-4 py-3.5 outline-none placeholder:text-on-surface-variant"
        />
        {template.fields.quantity && (
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            placeholder="Qty"
            aria-label="Quantity"
            className="w-16 rounded-2xl bg-surface-high px-3 py-3.5 text-center outline-none placeholder:text-on-surface-variant"
          />
        )}
        <button
          type="submit"
          aria-label="Add item"
          className="press grid size-[3.25rem] shrink-0 place-items-center rounded-2xl bg-primary text-on-primary"
        >
          <Add className="size-6" aria-hidden />
        </button>
      </form>
      <AnimatePresence initial={false}>
        {suggestions.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pt-2.5 [scrollbar-width:none]" aria-label="Bought before">
              {suggestions.map((s) => (
                <Chip key={s.name} onClick={() => addItem({ name: s.name, quantity: quantity.trim() || s.quantity })} icon={<History className="size-4" />}>
                  {s.name}
                </Chip>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {sections.map((section) => (
        <section key={section.name ?? 'all'}>
          {section.name ? <SectionTitle>{section.name}</SectionTitle> : <div className="h-4" />}
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {section.items.map((item) => (
                <motion.li
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 40 }}
                  transition={expressive.defaultSpatial}
                  className="flex items-center gap-3 rounded-3xl bg-surface-low px-4 py-3"
                >
                  <Checkbox checked={false} label={`Got ${item.name}`} onChange={() => setTimeout(() => check(item, true), 250)} />
                  <button type="button" onClick={() => setEditing(item)} className="min-w-0 flex-1 text-left">
                    {item.name}
                    {(item.note || item.price) && (
                      <span className="block text-sm text-on-surface-variant">{[item.price, item.note].filter(Boolean).join(' · ')}</span>
                    )}
                  </button>
                  {item.quantity && <span className="rounded-full bg-surface-high px-3 py-1 text-sm">{item.quantity}</span>}
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noreferrer noopener" aria-label={`Open the link for ${item.name}`} className="grid size-9 place-items-center rounded-full text-primary hover:bg-surface-high">
                      <LinkIcon className="size-5" aria-hidden />
                    </a>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </section>
      ))}
      {data && data.open.length === 0 && <p className="mt-6 text-center text-on-surface-variant">All clear. Nothing on the list.</p>}

      {data && data.checked.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowChecked((v) => !v)}
            aria-expanded={showChecked}
            className="mt-7 mb-2 flex w-full items-center justify-between px-1 text-sm font-medium text-primary"
          >
            {template.resettable ? 'Packed' : 'Recently got'} · tap to add again
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
                    onClick={() => check(item, false)}
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

      <ItemSheet item={editing} template={template} onClose={() => setEditing(null)} onSave={(patch) => editing && edit(editing, patch)} />
    </>
  );
}
