// The first screens: what Amble is, then the ways to start. On this device only (Amble asks what
// to call you), from Google Drive, with the household's own server, or from a saved copy; opened
// from a server, that server rather than Drive. Also the screens for when another tab has the
// database, the browser won't give Amble storage, or a page breaks.
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import ArrowBack from '~icons/material-symbols/arrow-back-rounded';
import ErrorIcon from '~icons/material-symbols/error-outline-rounded';
import EventAvailable from '~icons/material-symbols/event-available-outline-rounded';
import Favorite from '~icons/material-symbols/favorite-outline-rounded';
import Lock from '~icons/material-symbols/lock-outline-rounded';
import { api, ApiError, appUrl, servedBy, type Member } from '../lib/api.ts';
import { deviceFailure, useHere, type DeviceState } from '../lib/device.ts';
import { refreshStatus } from '../lib/drive-sync.ts';
import { applyUpdate, useUpdateReady } from '../lib/pwa.ts';
import { googleConfigured, resumeAfterGoogle, tokenFromTap } from '../lib/google.ts';
import { useServerReturn } from '../lib/server-sync.ts';
import { useRestoreCopy } from '../components/CopySection.tsx';
import { ServerForm } from '../components/ServerForm.tsx';
import { joinHousehold } from './SyncSettings.tsx';
import { expressive } from '../lib/motion.ts';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-6 py-12">
      <motion.img
        src={appUrl('/icon.svg')}
        alt=""
        initial={{ scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={expressive.slowSpatial}
        className="size-24"
      />
      <h1 className="display mt-8 text-[3.5rem] leading-none font-medium">Amble</h1>
      {children}
    </main>
  );
}

type Step = 'intro' | 'you' | 'ai';

// Opened from the code on a server's page (shared/qr.ts): straight to joining it.
const joining = servedBy != null && new URLSearchParams(location.search).has('join');
if (joining) history.replaceState(null, '', location.pathname);

/** One plain point on the first screen. */
function Point({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container">{icon}</span>
      <span>
        <span className="block font-medium">{title}</span>
        <span className="mt-0.5 block text-on-surface-variant">{children}</span>
      </span>
    </li>
  );
}

/** Each step slides in from the side it comes from. */
function StepIn({ step, children }: { step: Step; children: React.ReactNode }) {
  return (
    <motion.div key={step} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={expressive.defaultSpatial}>
      {children}
    </motion.div>
  );
}

/**
 * The first screens: what Amble is, said plainly; then a name to start with, or a way back in to a
 * household that already uses it; then, for someone starting fresh, a word about the optional AI.
 */
export function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(joining ? 'you' : 'intro');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [server, setServer] = useState(false);
  const copy = useRestoreCopy();
  // Came from the code: joining comes first, with starting alone a step aside.
  const [joinFirst, setJoinFirst] = useState(joining);

  // Sync is on now: the views and the sync loop (which read "off" when the app opened) catch up.
  const joined = () => Promise.all([qc.invalidateQueries(), refreshStatus().catch(() => null)]);

  // Back from signing in on the household's server: the device has its data now.
  useServerReturn('welcome-server', (outcome) => {
    if (outcome.ok) void joined();
    else {
      setStep('you');
      setJoinFirst(false);
      setServer(true);
      setError(outcome.error);
    }
  });

  /** A second device: whatever this Google account syncs comes in, and the device is theirs. */
  const fromDrive = async () => {
    setStep('you');
    setSaving(true);
    setError(null);
    try {
      const token = await tokenFromTap('welcome');
      const { households } = await api<{ households: { id: string }[] }>('/sync/households', { method: 'POST', body: JSON.stringify({ token }) });
      if (households.length) await joinHousehold('welcome');
      else await api('/sync/connect', { method: 'POST', body: JSON.stringify({ token, mode: 'personal' }) });
      await joined();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Try again.");
    } finally {
      setSaving(false);
    }
  };

  // Back from Google after "Sign in with Google": carry on.
  useEffect(() => {
    const back = resumeAfterGoogle('welcome');
    if (back?.error) {
      setStep('you');
      setError(back.error);
    } else if (back) void fromDrive();
  }, []);

  // The device is set up as them, but the app waits behind the last step until they carry on.
  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api<{ member: Member }>('/device/start', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      setStep('ai');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "That didn't work. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const enter = async (to?: '/settings/ai') => {
    await qc.invalidateQueries();
    if (to) void navigate({ to });
  };

  const primary = 'press h-14 rounded-full bg-primary px-6 text-lg font-medium text-on-primary disabled:opacity-40';
  const quiet = 'press h-12 rounded-full px-6 font-medium text-primary disabled:opacity-40';
  const here = servedBy ? new URL(servedBy.url).host : null;

  return (
    <Frame>
      <AnimatePresence mode="wait" initial={false}>
        {step === 'intro' && (
          <StepIn step="intro">
            <p className="mt-3 text-lg text-on-surface-variant">A calm planner for you and your household.</p>
            <ul className="mt-8 flex flex-col gap-5">
              <Point icon={<EventAvailable className="size-5" aria-hidden />} title="It knows how full your days are">
                So it suggests what fits, plans around your calendar, and never nags.
              </Point>
              <Point icon={<Favorite className="size-5" aria-hidden />} title="Free, every feature, for good">
                No account, no ads, no subscription. Use it on your phone, your computer, or both.
              </Point>
              <Point icon={<Lock className="size-5" aria-hidden />} title="Your things stay yours">
                Everything lives on your device. Sync it through your Google Drive or your own server, only if you want to.
              </Point>
            </ul>
            <p className="mt-8 text-sm text-on-surface-variant">
              Made by a busy dad who got tired of paying for planners that weren't any good. This one is free, and it's meant to be good.
            </p>
            <div className="mt-8 flex flex-col">
              <button type="button" onClick={() => setStep('you')} className={primary}>
                Get started
              </button>
            </div>
          </StepIn>
        )}

        {step === 'you' && joinFirst && here && (
          <StepIn step="you">
            <p className="mt-3 text-lg">Join your household on {here}. You sign in there with your own account.</p>
            <div className="mt-6">
              <ServerForm action="welcome-server" />
            </div>
            <button type="button" onClick={() => setJoinFirst(false)} className={`mt-4 ${quiet}`}>
              Start on this device instead
            </button>
          </StepIn>
        )}

        {step === 'you' && !(joinFirst && here) && (
          <StepIn step="you">
            <form onSubmit={start} className="mt-8 flex flex-col gap-3">
              <label className="flex flex-col gap-2">
                <span className="font-medium">What should Amble call you?</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="given-name"
                  autoFocus
                  maxLength={80}
                  placeholder="Your first name"
                  className="rounded-2xl bg-surface-high px-4 py-4 text-lg outline-none focus-visible:ring-2 focus-visible:ring-primary"
                />
              </label>
              {error && (
                <p role="alert" className="flex gap-2 text-error">
                  <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
                  {error}
                </p>
              )}
              <button type="submit" disabled={!name.trim() || saving} className={`mt-2 ${primary}`}>
                Start
              </button>
            </form>

            <h2 className="mt-10 px-1 text-sm font-medium text-primary">Already use Amble?</h2>
            <div className="mt-2 flex flex-col gap-1">
              {here && !server && (
                <button type="button" onClick={() => setServer(true)} disabled={saving} className={quiet}>
                  Join through {here}
                </button>
              )}
              {googleConfigured && !here && (
                <>
                  <button type="button" onClick={() => void fromDrive()} disabled={saving} className={quiet}>
                    Sign in with Google
                  </button>
                  <p className="px-6 text-center text-sm text-on-surface-variant">Brings in what you have, or joins a household someone shared.</p>
                </>
              )}
              {!here && !server && (
                <button type="button" onClick={() => setServer(true)} disabled={saving} className={quiet}>
                  Use my own server
                </button>
              )}
              <button type="button" onClick={copy.pick} disabled={saving || copy.restoring} className={quiet}>
                {copy.restoring ? 'Restoring…' : 'Restore a saved copy'}
              </button>
              {copy.input}
            </div>
            {server && (
              <div className="mt-3">
                <ServerForm action="welcome-server" onCancel={() => setServer(false)} />
              </div>
            )}
            <button type="button" onClick={() => setStep('intro')} className="mt-6 inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium text-on-surface-variant">
              <ArrowBack className="size-5" aria-hidden />
              Back
            </button>
          </StepIn>
        )}

        {step === 'ai' && (
          <StepIn step="ai">
            <p className="mt-3 text-lg">Hi, {name.trim()}. One optional extra, and then you're in.</p>
            <div className="mt-6 flex flex-col gap-4 text-on-surface-variant">
              <p>Amble picks up days and times as you type: "dentist Thursday at 3" goes on Thursday afternoon.</p>
              <p>
                With an AI model it can do more. It turns "call mom tomorrow, out of milk and eggs" into a task and two grocery items, guesses how long things
                take, and lays out your week around what's already on it.
              </p>
              <p>
                The model is yours to pick, from whoever you like. Some are free to start, and one on your own computer works too. Without one, everything
                else works the same, and nothing goes to an AI service.
              </p>
            </div>
            <div className="mt-8 flex flex-col gap-1">
              <button type="button" onClick={() => void enter()} className={primary}>
                Start planning
              </button>
              <button type="button" onClick={() => void enter('/settings/ai')} className={quiet}>
                Add an AI model now
              </button>
            </div>
          </StepIn>
        )}
      </AnimatePresence>
    </Frame>
  );
}

/**
 * A page broke. Says so plainly, with what went wrong (worth passing on), and a way back. A new
 * version waiting is applied first: a page left open across an update is the likeliest cause.
 */
export function PageError({ error }: { error: unknown }) {
  const updateReady = useUpdateReady();
  useEffect(() => {
    console.error(error);
    if (updateReady) applyUpdate();
  }, [error, updateReady]);
  return (
    <Frame>
      <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
        <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">This page ran into a problem.</p>
          <p className="mt-1 text-sm">Your things are fine. Trying again usually sorts it out.</p>
          {error instanceof Error && <p className="mt-2 text-sm break-words opacity-80">{error.message}</p>}
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="press h-12 rounded-full bg-primary px-6 font-medium text-on-primary"
        >
          Try again
        </button>
        <a href={appUrl('/')} className="rounded-full px-6 py-3 font-medium text-primary hover:bg-surface-high">
          Back to Today
        </a>
      </div>
    </Frame>
  );
}

/** Amble on this device didn't answer when the app opened. A new version waiting is applied first (main.tsx). */
export function StartFailed({ error }: { error: unknown }) {
  return (
    <Frame>
      <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
        <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">Amble couldn't start on this device.</p>
          <p className="mt-1 text-sm">Your things are still here. Trying again usually sorts it out.</p>
          {error instanceof Error && <p className="mt-2 text-sm opacity-80">{error.message}</p>}
        </div>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="press mt-6 h-12 rounded-full bg-primary px-6 font-medium text-on-primary"
      >
        Try again
      </button>
    </Frame>
  );
}

/** Shown instead of the app while the device's database isn't this tab's to use. */
export function DeviceBlocked({ state }: { state: DeviceState }) {
  if (state === 'failed') {
    return (
      <Frame>
        <div role="alert" className="mt-8 flex gap-3 rounded-3xl bg-warm-container p-4 text-on-warm-container">
          <ErrorIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div>
            <p className="font-medium">Amble couldn't open its storage on this device.</p>
            <p className="mt-1 text-sm">
              A private window, or a browser set not to keep data for sites, can stop it. Try a normal window.
            </p>
            {deviceFailure() && <p className="mt-2 text-sm opacity-80">{deviceFailure()}</p>}
          </div>
        </div>
      </Frame>
    );
  }
  return (
    <Frame>
      <p className="mt-6 text-lg">{state === 'moved' ? 'Amble moved to another tab.' : 'Amble is open in another tab.'}</p>
      <p className="mt-2 text-on-surface-variant">It can be open in one tab at a time on this device.</p>
      <button
        type="button"
        onClick={useHere}
        className="press mt-10 h-14 rounded-full bg-primary px-6 text-lg font-medium text-on-primary"
      >
        Use it here
      </button>
    </Frame>
  );
}
