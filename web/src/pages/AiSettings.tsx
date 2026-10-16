import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import Check from '~icons/material-symbols/check-rounded';
import OpenInNew from '~icons/material-symbols/open-in-new-rounded';
import { AI_PROVIDERS, aiModel, aiProvider, type AiEffort, type AiModel, type AiProviderId } from '../../../shared/ai.ts';
import { ButtonGroup, SectionTitle, segment, SubpageHeader } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { expressive } from '../lib/motion.ts';
import { useAi, useMe } from '../lib/queries.ts';

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

/** Which AI model smart add and the planner use: any provider's, with the admin's own key. */
export function AiSettings() {
  const me = useMe();
  const qc = useQueryClient();
  const { data: ai } = useAi();
  const admin = me?.role === 'admin';
  const [draft, setDraft] = useState<Draft>(() => blank('anthropic'));
  // On a device using the household's server's model, the form for one of its own waits for a tap.
  const [own, setOwn] = useState(false);
  const fromServer = ai?.source === 'server';
  // What trying it said. `tried` is false when the server refused before asking the model.
  const [result, setResult] = useState<{ ok: true; ms: number | null } | { ok: false; error: string; tried: boolean } | null>(null);

  // Start from what's set up, once it loads.
  useEffect(() => {
    const s = ai?.settings;
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
  }, [ai?.settings?.provider, ai?.settings?.model]);

  const provider = aiProvider(draft.provider)!;
  const known = aiModel(draft.provider, draft.model);
  const savedKey = ai?.settings?.provider === draft.provider ? ai.settings.keyEnding : null;
  const update = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setResult(null);
  };

  const save = useMutation({
    mutationFn: (check: boolean) => {
      const priced = draft.priceIn.trim() !== '' && draft.priceOut.trim() !== '';
      return api<{ ok: true; ms: number | null } | { ok: false; error: string }>('/ai', {
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
        void qc.invalidateQueries({ queryKey: ['ai'] });
        void qc.invalidateQueries({ queryKey: ['session'] });
      }
    },
    onError: (err) => setResult({ ok: false, error: err instanceof ApiError ? err.message : String(err), tried: false }),
  });

  const remove = useMutation({
    mutationFn: () => api('/ai', { method: 'DELETE' }),
    onSuccess: () => {
      setResult(null);
      void qc.invalidateQueries({ queryKey: ['ai'] });
      void qc.invalidateQueries({ queryKey: ['session'] });
    },
  });

  const canSave = draft.model.trim() !== '' && (draft.provider !== 'custom' || draft.baseUrl.trim() !== '') && (draft.provider === 'custom' || savedKey != null || draft.apiKey.trim() !== '');

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
              {ai.source === 'environment' ? ', set in the server’s environment' : fromServer ? ', from your server' : ''}
            </p>
            <p className="mt-3 text-sm">
              {fromServer
                ? 'Your server keeps the key, and counts what it costs against its own monthly cap.'
                : ai.priced
                  ? `$${ai.monthSpendUsd.toFixed(2)} of the $${ai.monthlyCapUsd} cap this month. Past it, AI features pause until next month.`
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
                  ? 'Pick a provider and paste a key below.'
                  : 'Ask the household admin to set one up.'}
            </p>
          </>
        )}
      </section>

      {admin && fromServer && !own && (
        <button type="button" onClick={() => setOwn(true)} className="mt-4 rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high">
          Use a key on this device instead
        </button>
      )}

      {admin && (!fromServer || own) && (
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
          {provider.deviceNote && (
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
            It stays on this device, and is only ever sent to {provider.id === 'custom' ? 'that address' : provider.name}.
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
            {ai?.source === 'settings' && (
              <button
                type="button"
                onClick={() => remove.mutate()}
                className="rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high"
              >
                {ai.server ? 'Use your server’s AI' : ai.environment ? 'Use the server’s setting' : 'Turn off'}
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
      )}
    </>
  );
}
