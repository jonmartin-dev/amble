// Settings → Sync and backup, on a device: keeping a copy in the person's Google Drive, making that
// a household others can join, and joining one someone shared; or syncing with the household's
// own server instead. Once a household has a server, that's the way: opened from one, Drive isn't
// offered, and a device still on Drive is offered a move to it, with a tap when the household file
// carries the invite. The first phone to move keeps the Drive file in step for the others meanwhile.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import CloudSync from '~icons/material-symbols/cloud-sync-outline-rounded';
import Groups from '~icons/material-symbols/groups-outline-rounded';
import PersonAdd from '~icons/material-symbols/person-add-outline-rounded';
import Warning from '~icons/material-symbols/warning-outline-rounded';
import { CopySection } from '../components/CopySection.tsx';
import { ListGroup, SectionTitle, SubpageHeader } from '../components/ui.tsx';
import { api, ApiError, servedBy } from '../lib/api.ts';
import { refreshStatus, syncNow, useDriveSync, type DriveSyncStatus } from '../lib/drive-sync.ts';
import { forgetRefreshToken, forgetToken, googleConfigured, pickHouseholdFile, resumeAfterGoogle, syncToken, tokenFromTap } from '../lib/google.ts';
import { refreshViews } from '../lib/mutations.ts';
import { useMe } from '../lib/queries.ts';
import { pairWithServer, useServerReturn } from '../lib/server-sync.ts';
import { useSnackbar } from '../lib/snackbar.tsx';
import { JoinCode } from '../components/JoinCode.tsx';
import { ServerForm } from '../components/ServerForm.tsx';

interface Person {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
}

const button = 'rounded-full bg-primary px-5 py-3 font-medium text-on-primary transition-opacity disabled:opacity-40';
const quiet = 'rounded-full px-4 py-2.5 text-sm font-medium text-primary hover:bg-surface-high disabled:opacity-40';

function syncedLabel(s: DriveSyncStatus, syncing: boolean, needsGoogle: boolean) {
  if (syncing) return 'Syncing…';
  if (needsGoogle) return 'Paused until you sign in to Google again';
  if (s.error) return s.error;
  if (s.waiting) return 'Changes here are waiting to sync';
  if (!s.syncedAt) return 'Not synced yet';
  const minutes = Math.round((Date.now() - new Date(s.syncedAt).getTime()) / 60_000);
  if (minutes < 1) return 'Up to date';
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  return minutes < 60 ? `Synced ${rtf.format(-minutes, 'minute')}` : `Synced ${rtf.format(-Math.round(minutes / 60), 'hour')}`;
}

/** Joins a household someone shared: Google's picker, then the file comes in. */
export async function joinHousehold(action: string, email?: string) {
  const token = await tokenFromTap(action, email);
  // Files this account made or picked before show up without the picker.
  const { households } = await api<{ households: { id: string; name: string }[] }>('/sync/households', { method: 'POST', body: JSON.stringify({ token }) });
  const fileId = households.length === 1 ? households[0]!.id : await pickHouseholdFile(token, email);
  if (!fileId) return null;
  return api<DriveSyncStatus>('/sync/connect', { method: 'POST', body: JSON.stringify({ token, mode: 'join', fileId }) });
}

export function SyncSettings() {
  const qc = useQueryClient();
  const snack = useSnackbar();
  const me = useMe();
  const { status, syncing, needsGoogle } = useDriveSync();
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [adding, setAdding] = useState<{ email: string; name: string } | null>(null);
  const [server, setServer] = useState(false);
  // On a server that turned this device's sign-in down: getting back in.
  const [again, setAgain] = useState(false);

  useEffect(() => {
    void refreshStatus().catch(() => {});
  }, []);

  // In on the household's server. A device that was on Drive needs Google no more, unless it keeps
  // the Drive file in step for the others for now.
  const moved = async () => {
    setServer(false);
    setAgain(false);
    const now = await refreshStatus().catch(() => null);
    if (!now?.bridge) {
      forgetToken();
      forgetRefreshToken();
    }
    snack({ message: 'Syncing with your server.' });
    void qc.invalidateQueries();
  };

  // Back from signing in on the household's server.
  useServerReturn('sync-server', (outcome) => {
    if (outcome.ok) void moved();
    else snack({ message: outcome.error });
  });

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await refreshStatus();
      refreshViews(qc);
    } catch (e) {
      snack({ message: e instanceof ApiError || e instanceof Error ? e.message : `${label} didn't work.` });
    } finally {
      setBusy(false);
    }
  };

  const connect = (mode: 'personal' | 'create') =>
    run('Syncing', async () => {
      const token = await tokenFromTap(`connect:${mode}`, status?.account?.email);
      const body = mode === 'create' ? { token, mode, name: `${me?.name ?? 'Our'}'s Amble household` } : { token, mode };
      await api('/sync/connect', { method: 'POST', body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: ['session'] });
    });

  const join = () =>
    run('Joining', async () => {
      if (await joinHousehold('join', status?.account?.email)) await qc.invalidateQueries({ queryKey: ['session'] });
    });

  const loadPeople = () =>
    run('Loading', async () => {
      const token = await tokenFromTap('people', status?.account?.email);
      setPeople((await api<{ people: Person[] }>('/sync/people', { method: 'POST', body: JSON.stringify({ token }) })).people);
    });

  const share = (email: string, name: string) =>
    run('Sharing', async () => {
      const token = await tokenFromTap('share', status?.account?.email);
      await api('/sync/share', { method: 'POST', body: JSON.stringify({ token, email, name }) });
      snack({ message: `Shared with ${email}. Google emailed them a link.` });
      setAdding(null);
      setPeople(null);
      void syncNow();
    });

  // Back from Google: carry on with what was tapped.
  useEffect(() => {
    for (const [action, go] of [
      ['connect:personal', () => connect('personal')],
      ['connect:create', () => connect('create')],
      ['join', join],
      ['people', loadPeople],
    ] as const) {
      const back = resumeAfterGoogle(action);
      if (back?.error) snack({ message: back.error });
      else if (back) void go();
    }
    // Once, when the page opens.
  }, []);

  const onServer = status?.target?.kind === 'server';
  const stop = () => {
    const where = onServer ? 'on your server' : 'in Google Drive';
    if (!confirm(`Stop syncing on this device? What’s here stays here, and the copy ${where} stays for your other devices.`)) return;
    void run('Stopping', async () => {
      await api('/sync', { method: 'DELETE' });
      forgetToken();
      forgetRefreshToken();
    });
  };

  const household = status?.target?.kind === 'household';
  const owner = household && status?.target?.owner === status?.account?.email;
  // Opened from the household's server, or on Drive in a household that has one: the server is the way.
  const offered = !onServer ? (servedBy?.url ?? status?.householdServer ?? null) : null;
  const offeredHost = offered ? new URL(offered).host : null;
  const serverWay = onServer || (!status?.on && offered != null);

  // Moving with the invite the household file carries, or a code from someone already there.
  const move = (to: string) => {
    if (!status?.householdJoin) return setServer(true);
    void run('Moving', async () => {
      if ((await pairWithServer(to, status.householdJoin!)) === 'joined') await moved();
      else setServer(true);
    });
  };

  const stopBridge = () =>
    run('Stopping', async () => {
      // Without asking: the invite only comes off the file if a token is at hand.
      const token = await syncToken(false, status?.bridge?.account ?? undefined).catch(() => null);
      await api('/sync/bridge', { method: 'DELETE', body: JSON.stringify(token ? { token } : {}) });
      forgetToken();
      forgetRefreshToken();
    });

  return (
    <>
      <SubpageHeader title="Sync and backup" />

      <section className="mt-4 rounded-[2rem] bg-secondary-container p-5 text-on-secondary-container">
        <div className="flex items-center gap-3">
          <CloudSync className="size-6" aria-hidden />
          <h2 className="display text-xl font-medium">{serverWay ? 'In step with your server' : 'Keep it in your Google Drive'}</h2>
        </div>
        <p className="mt-2">
          {serverWay
            ? 'Your household runs its own Amble server, and this device keeps in step with it, along with everyone else’s, photos and files on tasks included.'
            : 'Amble keeps a copy in your own Google Drive and brings your other devices and your household in step with it. It can only see the files it makes there, and nothing goes anywhere else.'}
        </p>
      </section>

      {!status?.on && offered ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          {server ? (
            <div className="w-full">
              <ServerForm action="sync-server" address={offered} onCancel={() => setServer(false)} joined={() => void moved()} />
            </div>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => setServer(true)} className={button}>
                Sync with {offeredHost}
              </button>
              <p className="px-1 text-sm text-on-surface-variant">
                With a code from a phone or computer that’s already in step with it. What’s on this device comes along.
              </p>
            </>
          )}
        </div>
      ) : !status?.on ? (
        <div className="mt-6 flex flex-col items-start gap-3">
          {googleConfigured ? (
            <>
              <button type="button" disabled={busy} onClick={() => void connect('personal')} className={button}>
                Sync with Google Drive
              </button>
              <button type="button" disabled={busy} onClick={() => void join()} className={quiet}>
                Join a household someone shared with you
              </button>
              <p className="px-1 text-sm text-on-surface-variant">Google asks once whether Amble can keep its files in your Drive.</p>
            </>
          ) : (
            <p className="flex gap-3 rounded-3xl bg-surface-low p-5 text-on-surface-variant">
              <Warning className="size-6 shrink-0" aria-hidden />
              This copy of Amble wasn't built with a Google sign-in client, so it can't sync through Google Drive.
            </p>
          )}
          <SectionTitle>Or your own server</SectionTitle>
          {server ? (
            <div className="w-full">
              <ServerForm action="sync-server" onCancel={() => setServer(false)} joined={() => void moved()} />
            </div>
          ) : (
            <button type="button" disabled={busy} onClick={() => setServer(true)} className={quiet}>
              Sync with your household's own server
            </button>
          )}
          <p className="px-1 text-sm text-on-surface-variant">A server shares photos and files on tasks too, which Google Drive can’t.</p>
        </div>
      ) : onServer ? (
        <>
          <SectionTitle>This device</SectionTitle>
          <ListGroup
            rows={[
              {
                icon: <CloudSync className="size-6" />,
                title: status.target?.name ?? 'Your server',
                subtitle: `${status.account?.email ?? ''} · ${syncedLabel(status, syncing, false)}`,
                trailing: (
                  <button type="button" disabled={busy || syncing} onClick={() => void run('Syncing', () => syncNow())} className={quiet}>
                    Sync now
                  </button>
                ),
              },
            ]}
          />
          <p className="mt-2 px-1 text-sm text-on-surface-variant">It syncs when Amble opens, every minute while it’s open, and soon after each change.</p>
          {status.error === 'Your server needs you to sign in again.' &&
            status.target?.url &&
            (again ? (
              <div className="mt-3">
                <ServerForm action="sync-server" address={status.target.url} onCancel={() => setAgain(false)} joined={() => void moved()} />
              </div>
            ) : (
              <button type="button" disabled={busy} onClick={() => setAgain(true)} className={`mt-3 ${button}`}>
                Get back in
              </button>
            ))}

          {status.bridge && (
            <section className="mt-6 flex flex-col items-start gap-3 rounded-3xl bg-surface-low p-5">
              <h3 className="font-medium">Also keeping “{status.bridge.name}” in step</h3>
              <p className="text-on-surface-variant">
                This device brought your household here from Google Drive, and keeps the Drive file in step for anyone who hasn’t moved yet. They’re
                offered the move in Settings, Sync and backup, with a tap. Once everyone’s here, stop.
              </p>
              <p className="text-sm text-on-surface-variant">
                {status.bridge.error ?? (status.bridge.syncedAt ? `Last kept in step ${new Date(status.bridge.syncedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not kept in step yet')}
              </p>
              <button type="button" disabled={busy} onClick={() => void stopBridge()} className={quiet}>
                Stop keeping Google Drive in step
              </button>
            </section>
          )}

          <SectionTitle>Add a phone or computer</SectionTitle>
          <p className="px-1 text-on-surface-variant">
            Photos and files on tasks are shared through {status.target?.name} too. Make a code here and use it on the new one: your own other phone or
            computer, or someone new to the household.
          </p>
          {status.target?.url && (
            <div className="mt-3">
              <JoinCode url={status.target.url} admin={me?.role === 'admin'} />
            </div>
          )}
          <SectionTitle>Stop</SectionTitle>
          <button type="button" disabled={busy} onClick={stop} className={quiet}>
            Stop syncing on this device
          </button>
        </>
      ) : (
        <>
          <SectionTitle>This device</SectionTitle>
          <ListGroup
            rows={[
              {
                icon: <CloudSync className="size-6" />,
                title: status.account?.email ?? 'Google Drive',
                subtitle: syncedLabel(status, syncing, needsGoogle),
                trailing: (
                  <button type="button" disabled={busy || syncing} onClick={() => void run('Syncing', () => syncNow({ tap: true }))} className={quiet}>
                    Sync now
                  </button>
                ),
              },
            ]}
          />
          <p className="mt-2 px-1 text-sm text-on-surface-variant">
            It syncs when Amble opens, every minute while it’s open, and soon after each change.
          </p>

          {offered && (
            <section className="mt-6 flex flex-col items-start gap-3 rounded-3xl bg-surface-low p-5">
              <h3 className="font-medium">Your household has its own server</h3>
              <p className="text-on-surface-variant">
                {offeredHost} keeps everyone in step, and shares photos and files on tasks, which Google Drive can’t. Move this device to it
                {status.householdJoin ? '' : ' with a code from someone who’s already there'}, and this device stops using Drive.
              </p>
              {server ? (
                <div className="w-full">
                  <ServerForm action="sync-server" address={offered} onCancel={() => setServer(false)} joined={() => void moved()} />
                </div>
              ) : (
                <button type="button" disabled={busy} onClick={() => move(offered)} className={button}>
                  Move to {offeredHost}
                </button>
              )}
            </section>
          )}

          <SectionTitle>Household</SectionTitle>
          {!household ? (
            <div className="flex flex-col items-start gap-3">
              <p className="px-1 text-on-surface-variant">Share Amble with the people you live with: groups, lists and tasks you can hand each other.</p>
              <button type="button" disabled={busy} onClick={() => void connect('create')} className={button}>
                <span className="flex items-center gap-2">
                  <Groups className="size-5" aria-hidden />
                  Make this a household
                </span>
              </button>
              <button type="button" disabled={busy} onClick={() => void join()} className={quiet}>
                Join a household someone shared with you instead
              </button>
            </div>
          ) : (
            <>
              <p className="px-1 text-on-surface-variant">
                Synced through “{status.target?.name}”{owner ? ' in your Drive' : status.target?.owner ? `, shared by ${status.target.owner}` : ''}.
              </p>
              {people ? (
                <ListGroup
                  rows={people.map((p) => ({
                    icon: <Groups className="size-6" />,
                    title: p.name || p.email || 'Someone',
                    subtitle: p.role === 'owner' ? `${p.email} · keeps the file` : (p.email ?? undefined),
                  }))}
                />
              ) : (
                <button type="button" disabled={busy} onClick={() => void loadPeople()} className={quiet}>
                  Show who it's shared with
                </button>
              )}
              {owner &&
                (adding ? (
                  <form
                    className="mt-3 flex flex-col gap-2 rounded-3xl bg-surface-low p-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (adding.email.trim()) void share(adding.email.trim(), adding.name.trim());
                    }}
                  >
                    <input
                      value={adding.name}
                      onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                      placeholder="Name"
                      aria-label="Name"
                      autoFocus
                      className="rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant"
                    />
                    <input
                      value={adding.email}
                      onChange={(e) => setAdding({ ...adding, email: e.target.value })}
                      placeholder="Their Google email"
                      aria-label="Email"
                      type="email"
                      className="rounded-2xl bg-surface-high px-4 py-3 outline-none placeholder:text-on-surface-variant"
                    />
                    <p className="px-1 text-sm text-on-surface-variant">
                      Google emails them a link. In Amble they choose “Join a household” and pick the file once.
                    </p>
                    <div className="flex justify-end gap-2">
                      <button type="button" onClick={() => setAdding(null)} className="rounded-full px-4 py-2 text-sm font-medium">
                        Cancel
                      </button>
                      <button type="submit" disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-40">
                        Share
                      </button>
                    </div>
                  </form>
                ) : (
                  <button type="button" onClick={() => setAdding({ email: '', name: '' })} className={`mt-2 flex items-center gap-2 ${quiet}`}>
                    <PersonAdd className="size-5" aria-hidden />
                    Add someone
                  </button>
                ))}
              <p className="mt-3 px-1 text-sm text-on-surface-variant">
                Everyone in the household has the whole file in their Drive. Private lists stay out of their view in Amble, but the file
                itself holds them. Photos and files on tasks stay on the devices of whoever added them, unless the household syncs with its
                own server.
              </p>
            </>
          )}

          <SectionTitle>Stop</SectionTitle>
          <button type="button" disabled={busy} onClick={stop} className={quiet}>
            Stop syncing on this device
          </button>
        </>
      )}

      <CopySection syncing={!!status?.on} />
    </>
  );
}
