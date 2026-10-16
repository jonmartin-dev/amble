// The sheets a list page opens: one item's details, the list's sections, and its menu.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import Add from '~icons/material-symbols/add-rounded';
import Close from '~icons/material-symbols/close-rounded';
import Copy from '~icons/material-symbols/content-copy-outline-rounded';
import Edit from '~icons/material-symbols/edit-outline-rounded';
import Down from '~icons/material-symbols/keyboard-arrow-down-rounded';
import Up from '~icons/material-symbols/keyboard-arrow-up-rounded';
import Label from '~icons/material-symbols/label-outline-rounded';
import Cart from '~icons/material-symbols/add-shopping-cart-rounded';
import { guessAisle } from '../../../shared/aisles.ts';
import { webLink } from '../../../shared/links.ts';
import { listSections, type ListTemplate } from '../../../shared/templates.ts';
import { api, ApiError, type Group, type ListItem } from '../lib/api.ts';
import { addListItem } from '../lib/local.ts';
import { useSend } from '../lib/mutations.ts';
import { useList, useListHistory } from '../lib/queries.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { ChipRow } from './fields.tsx';
import { Chip, ListGroup, Sheet } from './ui.tsx';

const fieldInput = 'w-full rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant';

/** Lines of text as ingredients: one per line, or separated by commas. */
function partsOf(text: string) {
  return text
    .split(/\n|,/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** One item's details: name, amount, section, store, link, price, ingredients and a note. */
export function ItemSheet({
  item,
  template,
  sections,
  stores,
  sendTo,
  onClose,
  onSave,
}: {
  item: ListItem | null;
  template: ListTemplate;
  sections: string[];
  /** Stores used on this list before. */
  stores: string[];
  /** The list a meal's ingredients go to, usually Groceries. */
  sendTo: Group | null;
  onClose: () => void;
  onSave: (patch: Partial<ListItem>) => void;
}) {
  const qc = useQueryClient();
  const send = useSend();
  const snack = useSnackbar();
  const [draft, setDraft] = useState<Partial<ListItem>>({});
  const [parts, setParts] = useState('');
  const [newSection, setNewSection] = useState<string | null>(null);
  const [newStore, setNewStore] = useState<string | null>(null);
  const { data: target } = useList(sendTo?.id ?? '', sendTo != null && item != null);
  const { data: targetHistory = [] } = useListHistory(sendTo && item ? sendTo.id : null);
  useEffect(() => {
    setDraft(item ?? {});
    setParts((item?.parts ?? []).join('\n'));
    setNewSection(null);
    setNewStore(null);
  }, [item]);
  const set = (patch: Partial<ListItem>) => setDraft((d) => ({ ...d, ...patch }));
  const label = template.sections?.label ?? 'Section';
  const allSections = [...new Set([...sections, ...(draft.section && !sections.includes(draft.section) ? [draft.section] : [])])];
  const allStores = [...new Set([...stores, ...(draft.store ? [draft.store] : [])])];
  // "amazon.com/…" is fine; something that can't be a page is caught here rather than turned down
  // by the server later, which would lose the rest of the changes with it.
  const link = webLink(draft.url);
  const badLink = !!draft.url?.trim() && !link;

  const patch = (): Partial<ListItem> => ({
    name: draft.name?.trim(),
    quantity: draft.quantity || null,
    note: draft.note || null,
    section: (newSection?.trim() || draft.section) ?? null,
    url: link,
    price: draft.price || null,
    ...(template.fields.store && { store: (newStore?.trim() || draft.store) ?? null }),
    ...(template.fields.parts && { parts: partsOf(parts).length ? partsOf(parts) : null }),
  });

  // Each ingredient goes on the other list the way someone typing it there would add it.
  const sendParts = () => {
    if (!sendTo || !target) return;
    const names = partsOf(parts);
    const aisles = listSections(target.group, target.open.map((i) => i.section));
    let added = 0;
    for (const name of names) {
      const known = targetHistory.find((h) => h.name.toLowerCase() === name.toLowerCase());
      const section = known?.section ?? guessAisle(name, aisles);
      const id = crypto.randomUUID();
      // One checked off before comes back on the list, so it counts as added too.
      if (addListItem(qc, sendTo.id, { id, name, section }) !== 'already on the list') added++;
      send('POST', `/lists/${sendTo.id}/items`, { id, name, section }, `Add ${name}`);
    }
    const already = names.length - added;
    snack({ message: `Added ${added} to ${sendTo.name}${already ? `, ${already} already there` : ''}` });
  };

  return (
    <Sheet
      open={item != null}
      onClose={onClose}
      label="Edit item"
      header={<p className="pb-1 text-lg font-medium">Edit item</p>}
      footer={
        <button
          type="button"
          disabled={!draft.name?.trim() || badLink}
          onClick={() => {
            onSave(patch());
            onClose();
          }}
          className="press h-12 w-full rounded-full bg-primary font-medium text-on-primary disabled:opacity-40"
        >
          Save
        </button>
      }
    >
      <div className="flex gap-2">
        <input value={draft.name ?? ''} onChange={(e) => set({ name: e.target.value })} aria-label="Name" className={`${fieldInput} flex-[3]`} />
        {template.fields.quantity && (
          <input value={draft.quantity ?? ''} onChange={(e) => set({ quantity: e.target.value })} placeholder="Qty" aria-label="Quantity" className={`${fieldInput} min-w-0 flex-1`} />
        )}
      </div>
      {(allSections.length > 0 || !template.sections?.days) && (
        <ChipRow label={label}>
          {allSections.map((s) => (
            <Chip
              key={s}
              selected={newSection == null && draft.section === s}
              onClick={() => {
                setNewSection(null);
                set({ section: draft.section === s ? null : s });
              }}
            >
              {s}
            </Chip>
          ))}
          {!template.sections?.days &&
            (newSection == null ? (
              <Chip onClick={() => setNewSection('')} icon={<Add />}>
                New
              </Chip>
            ) : (
              <input
                autoFocus
                value={newSection}
                onChange={(e) => setNewSection(e.target.value)}
                placeholder={`New ${label.toLowerCase()}`}
                aria-label={`New ${label.toLowerCase()}`}
                className="h-9 w-40 shrink-0 rounded-full bg-secondary-container px-3.5 text-sm text-on-secondary-container outline-none placeholder:text-on-secondary-container/70"
              />
            ))}
        </ChipRow>
      )}
      {template.fields.store && (
        <ChipRow label="Store">
          {allStores.map((s) => (
            <Chip
              key={s}
              selected={newStore == null && draft.store === s}
              onClick={() => {
                setNewStore(null);
                set({ store: draft.store === s ? null : s });
              }}
            >
              {s}
            </Chip>
          ))}
          {newStore == null ? (
            <Chip onClick={() => setNewStore('')} icon={<Add />}>
              {allStores.length ? 'Another' : 'Add a store'}
            </Chip>
          ) : (
            <input
              autoFocus
              value={newStore}
              onChange={(e) => setNewStore(e.target.value)}
              placeholder="Store"
              aria-label="New store"
              className="h-9 w-40 shrink-0 rounded-full bg-secondary-container px-3.5 text-sm text-on-secondary-container outline-none placeholder:text-on-secondary-container/70"
            />
          )}
        </ChipRow>
      )}
      {template.fields.url && (
        <>
          <input
            value={draft.url ?? ''}
            onChange={(e) => set({ url: e.target.value })}
            placeholder="Link"
            inputMode="url"
            aria-label="Link"
            aria-invalid={badLink}
            className={`${fieldInput} mt-3 ${badLink ? 'ring-2 ring-error' : ''}`}
          />
          {badLink && <p className="mt-1 px-1 text-xs text-error">That doesn't look like a web link.</p>}
        </>
      )}
      {template.fields.price && (
        <input value={draft.price ?? ''} onChange={(e) => set({ price: e.target.value })} placeholder="Price" aria-label="Price" className={`${fieldInput} mt-3`} />
      )}
      {template.fields.parts && (
        <>
          <p className="mt-3 mb-1.5 px-1 text-xs text-on-surface-variant">Ingredients</p>
          <textarea
            value={parts}
            onChange={(e) => setParts(e.target.value)}
            placeholder="Ingredients, one per line"
            aria-label="Ingredients"
            rows={4}
            className={`${fieldInput} field-sizing-content max-h-60 min-h-24 resize-none`}
          />
          {sendTo && partsOf(parts).length > 0 && (
            <button
              type="button"
              onClick={sendParts}
              disabled={!target}
              className="press mt-2 flex h-11 items-center gap-2 rounded-full bg-secondary-container px-4 text-sm font-medium text-on-secondary-container disabled:opacity-50"
            >
              <Cart className="size-5" aria-hidden />
              Add {partsOf(parts).length === 1 ? 'it' : `all ${partsOf(parts).length}`} to {sendTo.name}
            </button>
          )}
        </>
      )}
      <input value={draft.note ?? ''} onChange={(e) => set({ note: e.target.value })} placeholder="Note" aria-label="Note" className={`${fieldInput} mt-3 mb-2`} />
    </Sheet>
  );
}

interface SectionRow {
  key: string;
  /** Its name when the sheet opened, so a rename takes its items along. */
  from: string | null;
  name: string;
}

/** Add, rename, reorder or remove a list's sections. */
export function SectionsSheet({ open, group, label, used, onClose }: { open: boolean; group: Group; label: string; used: (string | null)[]; onClose: () => void }) {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const [rows, setRows] = useState<SectionRow[]>([]);
  const [adding, setAdding] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setRows(listSections(group, used).map((s) => ({ key: s, from: s, name: s })));
    setAdding('');
    // Only when it opens, so the list refreshing behind it doesn't undo someone's edits.
  }, [open]);

  const move = (i: number, by: number) =>
    setRows((r) => {
      const next = [...r];
      const [row] = next.splice(i, 1);
      next.splice(i + by, 0, row!);
      return next;
    });
  const add = () => {
    const name = adding.trim();
    if (!name || rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return;
    setRows((r) => [...r, { key: crypto.randomUUID(), from: null, name }]);
    setAdding('');
  };
  const save = () => {
    setSaving(true);
    const sections = rows.map((r) => r.name.trim()).filter(Boolean);
    const renames = rows.filter((r) => r.from && r.name.trim() && r.from !== r.name.trim()).map((r) => ({ from: r.from!, to: r.name.trim() }));
    api(`/lists/${group.id}/sections`, { method: 'PUT', body: JSON.stringify({ sections, renames }) })
      .then(() => {
        void qc.invalidateQueries({ queryKey: ['list', group.id] });
        void qc.invalidateQueries({ queryKey: ['groups'] });
        snack({ message: `Saved the ${label.toLowerCase()}s on ${group.name}` });
        onClose();
      })
      .catch((e: Error) => snack({ message: e instanceof ApiError && e.status === 0 ? 'Changing sections needs a connection.' : e.message }))
      .finally(() => setSaving(false));
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      label={`${label}s`}
      header={
        <div className="pb-1">
          <p className="display text-2xl font-medium">{label}s</p>
          <p className="text-sm text-on-surface-variant">In the order you go through them. Renaming one moves its items along.</p>
        </div>
      }
      footer={
        <button type="button" onClick={save} disabled={saving} className="press h-12 w-full rounded-full bg-primary font-medium text-on-primary disabled:opacity-40">
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <ul className="mt-1 flex flex-col gap-0.5">
        {rows.map((r, i) => (
          <li key={r.key} className={`flex items-center gap-1 bg-surface-high py-1 pr-1 pl-4 ${i === 0 ? 'rounded-t-3xl' : 'rounded-t-md'} ${i === rows.length - 1 ? 'rounded-b-3xl' : 'rounded-b-md'}`}>
            <input
              value={r.name}
              onChange={(e) => setRows((all) => all.map((x) => (x.key === r.key ? { ...x, name: e.target.value } : x)))}
              aria-label={`${label} name`}
              className="min-w-0 flex-1 bg-transparent py-2 outline-none"
            />
            <button type="button" aria-label={`Move ${r.name} up`} disabled={i === 0} onClick={() => move(i, -1)} className="grid size-10 place-items-center rounded-full disabled:opacity-30">
              <Up className="size-5" aria-hidden />
            </button>
            <button type="button" aria-label={`Move ${r.name} down`} disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="grid size-10 place-items-center rounded-full disabled:opacity-30">
              <Down className="size-5" aria-hidden />
            </button>
            <button type="button" aria-label={`Remove ${r.name}`} onClick={() => setRows((all) => all.filter((x) => x.key !== r.key))} className="grid size-10 place-items-center rounded-full text-on-surface-variant">
              <Close className="size-5" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 mb-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={`Add a ${label.toLowerCase()}`} aria-label={`New ${label.toLowerCase()}`} className={`${fieldInput} flex-1`} />
        <button type="submit" aria-label={`Add ${label.toLowerCase()}`} disabled={!adding.trim()} className="press grid size-12 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container disabled:opacity-40">
          <Add className="size-6" aria-hidden />
        </button>
      </form>
    </Sheet>
  );
}

/** What else a list can do: its sections, sharing it as text, and its name and look. */
export function ListMenu({
  open,
  sectionsLabel,
  onClose,
  onSections,
  onShare,
  onEdit,
}: {
  open: boolean;
  /** Null for a list whose sections can't change, like a meal plan's days. */
  sectionsLabel: string | null;
  onClose: () => void;
  onSections: () => void;
  onShare: () => void;
  onEdit: () => void;
}) {
  const then = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <Sheet open={open} onClose={onClose} label="List options">
      <div className="pt-1 pb-2">
        <ListGroup
          rows={[
            ...(sectionsLabel ? [{ icon: <Label className="size-6" />, title: `${sectionsLabel}s`, subtitle: 'Add, rename or reorder them', onClick: then(onSections) }] : []),
            { icon: <Copy className="size-6" />, title: 'Share as text', subtitle: "What's left, to send to someone", onClick: then(onShare) },
            { icon: <Edit className="size-6" />, title: 'Name and look', subtitle: 'Rename, recolor or archive the list', onClick: then(onEdit) },
          ]}
        />
      </div>
    </Sheet>
  );
}
