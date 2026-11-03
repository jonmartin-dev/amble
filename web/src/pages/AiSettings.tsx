import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import ExpandMore from '~icons/material-symbols/expand-more-rounded';
import OpenInNew from '~icons/material-symbols/open-in-new-rounded';
import { AI_PROVIDERS, aiModel, aiProvider, type AiEffort, type AiModel, type AiProviderId } from '../../../shared/ai.ts';
import { ButtonGroup, SectionTitle, segment, SubpageHeader } from '../components/ui.tsx';
import { api, ApiError, type AiEditable } from '../lib/api.ts';
import { syncNow, useDriveSync } from '../lib/drive-sync.ts';
import { expressive } from '../lib/motion.ts';
import { useAi, useMe, useServerSettings } from '../lib/queries.ts';

const field = 'w-full rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant';

function priceLabel(m: AiModel) {
  if (m.free === 'model') return 'Free';
  const [input, output] = m.price.map((p) => `$${p.toFixed(2)}`);
  return `${input} in, ${output} out per million tokens${m.free === 'tier' ? ', or a free tier' : ''}`;
}

const EFFORTS: { value: AiEffort; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

interface Draft {
  provider: AiProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  effort: AiEffort;
  cap: string;
  priceIn: string;
  priceOut: string;
}

const blank = (provider: AiProviderId): Draft => {
  const first = aiProvider(provider)?.models[0];
  return { provider, model: first?.id ?? '', baseUrl: '', apiKey: '', effort: first?.effort ?? 'default', cap: '10', priceIn: '', priceOut: '' };
};

/**
 * Picking a model and its key: for this device alone (`path` /ai), for the household through its
 * file in Google Drive (/ai/household), or on the household's server (/sync/server/settings/ai).
 * Everyone's devices use the household's, either way. `keyNote` says where the key is kept, and
 * runs on into "only ever sent to …".
 */
function AiForm({
  settings,
  path,
  onServer = false,
  keyNote,
  capNote,
  removeLabel,
  changed,
}: {
  settings: AiEditable | null | undefined;
  path: string;
  onServer?: boolean;
  keyNote: string;
  capNote?: string;
  /** What taking it away does, when there's one to take away. */
  removeLabel: string | null;
  changed: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => blank('anthropic'));
  // What trying it said. `tried` is false when it was refused before asking the model.
  const [result, setResult] = useState<{ ok: true; ms: number | null } | { ok: false; error: string; tried: boolean } | null>(null);

  // Start from what's set up, once it loads.
  useEffect(() => {
    const s = settings;
    if (!s) return;
    setDraft({
      provider: s.provider,
      model: s.model,
      baseUrl: s.provider === 'custom' ? s.baseUrl : '',
      apiKey: '',
      effort: s.effort,
      cap: String(s.monthlyCapUsd),
      priceIn: s.prices && !aiModel(s.provider, s.model) ? String(s.prices[0]) : '',
      priceOut: s.prices && !aiModel(s.provider, s.model) ? String(s.prices[1]) : '',
    });
  }, [settings?.provider, settings?.model]);

  const provider = aiProvider(draft.provider)!;
  const known = aiModel(draft.provider, draft.model);
  const savedKey = settings?.provider === draft.provider ? settings.keyEnding : null;
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setResult(null);
  };

  const save = useMutation({
    mutationFn: (check: boolean) => {
      const priced = draft.priceIn.trim() !== '' && draft.priceOut.trim() !== '';
      return api<{ ok: true; ms: number | null } | { ok: false; error: string }>(path, {
        method: 'PUT',
        body: JSON.stringify({
          provider: draft.provider,
          model: draft.model.trim(),
          baseUrl: draft.baseUrl.trim(),
          apiKey: draft.apiKey.trim(),
          effort: draft.effort,
          monthlyCapUsd: Number(draft.cap) || 0,
          prices: !known && priced ? [Number(draft.priceIn), Number(draft.priceOut)] : null,
          check,
        }),
      });
    },
    onSuccess: (res) => {
      setResult(res.ok ? res : { ...res, tried: true });
      if (res.ok) {
        setDraft((d) => ({ ...d, apiKey: '' }));
        changed();
      }
    },
    onError: (err) => setResult({ ok: false, error: err instanceof ApiError ? err.message : String(err), tried: false }),
  });

  const remove = useMutation({
    mutationFn: () => api(path, { method: 'DELETE' }),
    onSuccess: () => {
      setResult(null);
      changed();
    },
  });

  const canSave = draft.model.trim() !== '' && (draft.provider !== 'custom' || draft.baseUrl.trim() !== '') && (draft.provider === 'custom' || savedKey != null || draft.apiKey.trim() !== '');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) save.mutate(true);
      }}
    >
      <SectionTitle>Provider</SectionTitle>
      <div role="radiogroup" aria-label="Provider" className="grid grid-cols-2 gap-1 medium:grid-cols-3">
        {AI_PROVIDERS.map((p) => {
          const on = p.id === draft.provider;
          const hint = p.id === 'custom' ? 'Ollama, LM Studio and more' : p.id === 'openrouter' ? 'One key, any model' : p.models[0]!.name;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => !on && update(blank(p.id))}
              className={`press flex min-h-16 flex-col justify-center rounded-2xl px-4 py-2.5 text-left transition-colors ${
                on ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-low hover:bg-surface-container'
              }`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {on && <Check className="size-5" aria-hidden />}
                {p.name}
              </span>
              <span className={`text-xs ${on ? '' : 'text-on-surface-variant'}`}>{hint}</span>
            </button>
          );
        })}
      </div>
      {provider.note && <p className="mt-2 px-1 text-sm text-on-surface-variant">{provider.note}</p>}
      {/* What a browser can't reach doesn't matter when the server does the asking. */}
      {!onServer && provider.deviceNote && (
        <p className={`mt-2 px-1 text-sm ${provider.fromBrowser ? 'text-on-surface-variant' : 'text-error'}`}>{provider.deviceNote}</p>
      )}

      <SectionTitle>Model</SectionTitle>
      {provider.models.length > 0 && (
        <ul role="radiogroup" aria-label="Suggested models" className="mb-2 flex flex-col gap-0.5">
          {provider.models.map((m, i) => {
            const on = m.id === draft.model;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => update({ model: m.id, effort: m.effort })}
                  className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${segment(i, provider.models.length)} ${
                    on ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-low hover:bg-surface-container'
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">
                      {m.name}
                      {i === 0 && <span className={`ml-2 text-xs font-normal ${on ? '' : 'text-primary'}`}>Suggested</span>}
                    </span>
                    <span className={`block text-sm ${on ? '' : 'text-on-surface-variant'}`}>{priceLabel(m)}</span>
                  </span>
                  {on && <Check className="size-6 shrink-0" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {/* Any other model: typing one picks it over the suggestions, and clearing it goes back. */}
      <input
        value={known ? '' : draft.model}
        onChange={(e) => {
          const typed = e.target.value;
          const preset = aiModel(draft.provider, typed.trim()) ?? (typed.trim() ? undefined : provider.models[0]);
          update({ model: typed.trim() ? typed : (preset?.id ?? ''), ...(preset && { effort: preset.effort }) });
        }}
        placeholder={draft.provider === 'custom' ? 'Model, like qwen3:4b' : 'Or another model id'}
        aria-label="Model id"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className={field}
      />
      {draft.provider === 'custom' && (
        <input
          value={draft.baseUrl}
          onChange={(e) => update({ baseUrl: e.target.value })}
          placeholder="Address, like http://localhost:11434/v1"
          aria-label="Address"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className={`${field} mt-2`}
        />
      )}

      <SectionTitle
        action={
          provider.keyUrl && (
            <a href={provider.keyUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-sm font-medium text-primary">
              Get a key
              <OpenInNew className="size-4" aria-hidden />
            </a>
          )
        }
      >
        API key
      </SectionTitle>
      <input
        value={draft.apiKey}
        onChange={(e) => update({ apiKey: e.target.value })}
        placeholder={savedKey ? `Saved, ending in ${savedKey}` : draft.provider === 'custom' ? 'Only if it needs one' : `Paste a key from ${provider.name}`}
        aria-label="API key"
        type="password"
        autoComplete="off"
        spellCheck={false}
        className={field}
      />
      <p className="mt-2 px-1 text-sm text-on-surface-variant">
        {keyNote} only ever sent to {provider.id === 'custom' ? 'that address' : provider.name}.
      </p>

      <SectionTitle>How hard it thinks</SectionTitle>
      <ButtonGroup value={draft.effort} options={EFFORTS} onChange={(effort) => update({ effort })} label="How hard it thinks" size="sm" />
      <p className="mt-2 px-1 text-sm text-on-surface-variant">
        For smart add, Plan my week and Tidy up. Higher is a little more careful and a little slower; size guesses and the morning's wording always stay
        quick. Models without a setting use their own.
      </p>

      <SectionTitle>Monthly cap</SectionTitle>
      <label className="flex items-center gap-2 rounded-2xl bg-surface-high px-4">
        <span className="text-on-surface-variant">$</span>
        <input
          value={draft.cap}
          onChange={(e) => update({ cap: e.target.value.replace(/[^\d.]/g, '') })}
          inputMode="decimal"
          aria-label="Monthly cap in dollars"
          className="min-w-0 flex-1 bg-transparent py-3 outline-none"
        />
      </label>
      {capNote && <p className="mt-2 px-1 text-sm text-on-surface-variant">{capNote}</p>}
      {!known && (
        <>
          <div className="mt-2 flex gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-surface-high px-4">
              <span className="text-on-surface-variant">$</span>
              <input
                value={draft.priceIn}
                onChange={(e) => update({ priceIn: e.target.value.replace(/[^\d.]/g, '') })}
                inputMode="decimal"
                placeholder="In"
                aria-label="Price in, per million tokens"
                className="min-w-0 flex-1 bg-transparent py-3 outline-none placeholder:text-on-surface-variant"
              />
            </label>
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl bg-surface-high px-4">
              <span className="text-on-surface-variant">$</span>
              <input
                value={draft.priceOut}
                onChange={(e) => update({ priceOut: e.target.value.replace(/[^\d.]/g, '') })}
                inputMode="decimal"
                placeholder="Out"
                aria-label="Price out, per million tokens"
                className="min-w-0 flex-1 bg-transparent py-3 outline-none placeholder:text-on-surface-variant"
              />
            </label>
          </div>
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            Its price per million tokens, so spending counts toward the cap. Leave these empty for a free or local model.
          </p>
        </>
      )}

      <AnimatePresence>
        {result && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={expressive.fastSpatial}
            className={`mt-5 rounded-3xl p-4 text-sm ${result.ok ? 'bg-primary-container text-on-primary-container' : 'bg-warm-container text-on-warm-container'}`}
          >
            {result.ok ? (
              result.ms == null
                ? 'Saved without trying it.'
                : result.ms < 1000
                  ? 'Saved. It answered in under a second.'
                  : `Saved. It answered in ${(result.ms / 1000).toFixed(1)} seconds.`
            ) : (
              <>
                <p>It didn't work: {result.error}</p>
                {result.tried && (
                  <button type="button" onClick={() => save.mutate(false)} className="mt-2 font-medium underline">
                    Save anyway
                  </button>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-5 flex items-center justify-end gap-2">
        {removeLabel && (
          <button type="button" onClick={() => remove.mutate()} className="rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high">
            {removeLabel}
          </button>
        )}
        <button
          type="submit"
          disabled={!canSave || save.isPending}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-on-primary disabled:opacity-40"
        >
          {save.isPending ? 'Trying it…' : 'Try it and save'}
        </button>
      </div>
      <p className="mt-3 px-1 text-sm text-on-surface-variant">Trying it asks one tiny question, a fraction of a cent on a paid plan.</p>
    </form>
  );
}

const ON_DEVICE = 'It stays on this device, and is';

/**
 * Which AI model smart add and the planner use: any provider's, with the admin's own key. A
 * household sets one for everyone: through its file in Google Drive, or on its own server. A key
 * on this device alone then waits under Advanced.
 */
export function AiSettings() {
  const me = useMe();
  const qc = useQueryClient();
  const { data: ai } = useAi();
  const admin = me?.role === 'admin';
  const kind = useDriveSync().status?.target?.kind;
  const onServer = kind === 'server';
  // Just you across your devices, or a household, keeping in step through Google Drive.
  const onDrive = kind === 'household' || kind === 'personal';
  const personal = kind === 'personal';
  const server = useServerSettings(onServer);
  const fromServer = ai?.source === 'server';
  const household = ai?.source === 'household';
  // This device's own key, when there's a shared one: open when it's the one in use.
  const [advanced, setAdvanced] = useState(false);
  const ownInUse = (onServer || onDrive) && ai?.source === 'settings';

  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['ai'] });
    void qc.invalidateQueries({ queryKey: ['session'] });
    void qc.invalidateQueries({ queryKey: ['server-settings'] });
  };
  // A change to the household's model reaches the others with this device's next round.
  const sharedChanged = () => {
    changed();
    void syncNow()
      .then(changed)
      .catch(() => {});
  };

  const source =
    ai?.source === 'environment'
      ? ', set in the server’s environment'
      : fromServer
        ? ', from your server'
        : household
          ? personal
            ? ', on all your devices'
            : ', your household’s'
          : ownInUse
            ? ', with a key on this device'
            : '';

  const ownKey = admin && (onServer || onDrive) && (
    <>
      <button
        type="button"
        onClick={() => setAdvanced(!(advanced || ownInUse))}
        aria-expanded={advanced || ownInUse}
        className="mt-8 flex w-full items-center gap-3 rounded-full px-4 py-3 text-left text-sm"
      >
        <span className="min-w-0 flex-1">
          <span className="font-medium text-primary">Advanced</span>
          <span className="block text-on-surface-variant">A key on this device only, instead of the shared one</span>
        </span>
        <ExpandMore className={`size-6 shrink-0 text-primary transition-transform ${advanced || ownInUse ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {(advanced || ownInUse) && (
        <>
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            This device then asks its own model, with a key kept on it, and {personal ? 'your other devices keep' : 'everyone else keeps'} using the shared one.
            Most {personal ? 'people' : 'households'} don't need this.
          </p>
          <AiForm
            settings={ai?.settings}
            path="/ai"
            keyNote={ON_DEVICE}
            removeLabel={ownInUse ? (onServer ? 'Use your server’s AI' : 'Use the shared model') : null}
            changed={changed}
          />
        </>
      )}
    </>
  );

  return (
    <>
      <SubpageHeader title="AI" />
      <p className="px-1 text-on-surface-variant">
        Smart add, size guesses, the morning's suggestions, Plan my week and Tidy up all use one fast AI model, from whichever provider you like. Without
        one, quick add takes text as typed, the planner words things itself, and everything else works the same.
      </p>

      <section aria-label="Model in use" className="mt-5 rounded-[2rem] bg-surface-low p-5">
        {ai?.available ? (
          <>
            <p className="text-sm text-on-surface-variant">In use</p>
            <p className="display mt-1 text-2xl font-medium">{ai.modelName}</p>
            <p className="mt-1 text-sm text-on-surface-variant">
              {ai.providerName}
              {source}
            </p>
            <p className="mt-3 text-sm">
              {fromServer
                ? 'Your server keeps the key, and counts what it costs against its own monthly cap.'
                : ai.priced
                  ? `$${ai.monthSpendUsd.toFixed(2)} of the $${ai.monthlyCapUsd} cap this month${household && !personal ? ', everyone together' : ''}. Past it, AI features pause until next month.`
                  : 'Spending isn’t counted for this model, so the monthly cap doesn’t apply.'}
            </p>
          </>
        ) : (
          <>
            <p className="display text-2xl font-medium">Not set up</p>
            <p className="mt-1 text-sm text-on-surface-variant">
              {ai?.keyUnreadable
                ? 'The saved key can’t be read since the server’s sign-in secret changed. Enter it again below.'
                : admin
                  ? onServer
                    ? 'Set one up for the household below. Your server keeps the key.'
                    : onDrive
                      ? personal
                        ? 'Set one up below, and each of your devices uses it.'
                        : 'Set one up below, and everyone in the household uses it.'
                      : 'Pick a provider and paste a key below.'
                  : 'Ask the household admin to set one up.'}
            </p>
          </>
        )}
      </section>

      {onServer ? (
        <>
          <SectionTitle>Your household's model</SectionTitle>
          <p className="px-1 text-on-surface-variant">
            Kept on your server{server.data ? `, ${new URL(server.data.url).host}` : ''}, and used by everyone's devices. The key never leaves the server.
          </p>
          {server.isPending ? (
            <p className="mt-3 px-1 text-sm text-on-surface-variant">Asking your server…</p>
          ) : server.isError ? (
            <p className="mt-3 rounded-3xl bg-warm-container p-4 text-sm text-on-warm-container">
              Couldn’t reach your server just now{server.error instanceof Error ? `: ${server.error.message}` : '.'}
            </p>
          ) : server.data.me.role === 'admin' ? (
            <AiForm
              settings={server.data.ai.settings}
              path="/sync/server/settings/ai"
              onServer
              keyNote="It’s kept on your server, locked, and"
              capNote="For the whole household together."
              removeLabel={server.data.ai.source === 'settings' ? (server.data.ai.environment ? 'Use the server’s setting' : 'Turn off') : null}
              changed={sharedChanged}
            />
          ) : (
            <p className="mt-3 px-1">
              {server.data.ai.available ? `${server.data.ai.modelName}, from ${server.data.ai.providerName}.` : 'None yet. The household admin sets one up here.'}
            </p>
          )}
          {ownKey}
        </>
      ) : onDrive ? (
        <>
          <SectionTitle>{personal ? 'Your model, on all your devices' : 'Your household’s model'}</SectionTitle>
          <p className="px-1 text-on-surface-variant">
            {personal
              ? 'Set it up once and each of your devices uses it. It syncs through Google Drive like everything else.'
              : 'Set it up once and everyone’s devices use it. It syncs through your household’s file in Google Drive like everything else.'}
          </p>
          {admin ? (
            <AiForm
              settings={ai?.household?.settings}
              path="/ai/household"
              keyNote={
                personal
                  ? 'It’s kept in Amble’s own folder in your Google Drive, and is'
                  : 'It’s kept in your household’s file in Google Drive, where anyone in the household could read it, and is'
              }
              capNote={personal ? 'For all your devices together.' : 'For the whole household together.'}
              removeLabel={ai?.household ? 'Turn off' : null}
              changed={sharedChanged}
            />
          ) : (
            <p className="mt-3 px-1">
              {ai?.household ? `${ai.household.modelName}, from ${ai.household.providerName}.` : 'None yet. The household admin sets one up here.'}
            </p>
          )}
          {ownKey}
        </>
      ) : (
        admin && <AiForm settings={ai?.settings} path="/ai" keyNote={ON_DEVICE} removeLabel={ai?.source === 'settings' ? 'Turn off' : null} changed={changed} />
      )}
    </>
  );
}
