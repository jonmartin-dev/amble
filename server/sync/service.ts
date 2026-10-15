// Keeping a copy of Amble in step through Google Drive. One file holds the state: in Amble's
// hidden folder in the person's own Drive when it's just them, or a shared "Amble household" file
// when it's a household. Each round downloads it if it changed, merges it in, and writes it back if
// this copy has changes it lacks. Two devices writing at once can overwrite each other; the next
// round notices its changes are missing and writes them again.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/open.ts';
import { groups, listItems, members, serverSettings, tasks } from '../db/schema.ts';
import { latestReading, startCapture, stamp, stopCapture } from './capture.ts';
import { createDrive, DriveAuthError, DriveError, HOUSEHOLD_MIME, pack, unpack, type Drive, type DriveFile } from './drive.ts';
import { Clock, newSite } from './hlc.ts';
import { exportState, mergeState, missingMine, NewerSchema, type SyncState } from './state.ts';

export const PERSONAL_FILE = 'almanac.state';
export const HOUSEHOLD_PROPERTY = { key: 'almanac', value: 'household' };

export interface SyncTarget {
  kind: 'personal' | 'household';
  fileId: string;
  name: string;
  /** Who made the household file, and so can share it. */
  owner: string | null;
}

interface Settings {
  site: string;
  target: SyncTarget | null;
  account: { email: string; name: string | null } | null;
  /** The file's checksum as this copy last merged or wrote it. */
  md5: string | null;
  /** Each device's latest change in that version, to tell if ours made it in. */
  sites: Record<string, string>;
  syncedAt: number | null;
  error: string | null;
}

export interface SyncStatus {
  on: boolean;
  target: SyncTarget | null;
  account: Settings['account'];
  syncedAt: string | null;
  error: string | null;
  /** Changes here that the Drive file doesn't have yet. */
  waiting: boolean;
}

export class SyncSetupError extends Error {}

/** What a device does once it knows whose Google account it's syncing with (see server/local.ts). */
export type Adopt = (account: { email: string; name: string | null }, localGroups: Set<string>, remote: SyncState | null) => void;

const KEY = 'sync';

export function createSyncService({ db, schema, fetchImpl = fetch, adopt }: { db: Db; schema: string; fetchImpl?: typeof fetch; adopt?: Adopt }) {
  const read = (): Settings | null => (db.select().from(serverSettings).where(eq(serverSettings.key, KEY)).get()?.value as Settings | undefined) ?? null;
  const write = (s: Settings) =>
    db.insert(serverSettings).values({ key: KEY, value: s }).onConflictDoUpdate({ target: serverSettings.key, set: { value: s } }).run();

  // The site is kept even while sync is off, so a device keeps its identity if it comes back.
  let settings = read();
  const site = settings?.site ?? newSite();
  const clock = new Clock(site);
  clock.see(latestReading(db));
  // Set up again on every start, so the triggers follow any columns a migration added.
  if (settings?.target) startCapture(db);

  const save = (patch: Partial<Settings>) => {
    settings = { site, target: null, account: null, md5: null, sites: {}, syncedAt: null, error: null, ...settings, ...patch };
    write(settings);
  };

  let running: Promise<unknown> = Promise.resolve();
  /** One round at a time; a second caller waits for the first. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = running.then(fn, fn);
    running = result.catch(() => {});
    return result;
  }

  async function fetchState(drive: Drive, file: DriveFile): Promise<SyncState> {
    return unpack<SyncState>(await drive.download(file.id));
  }

  async function upload(drive: Drive, target: SyncTarget) {
    const state = exportState(db, clock, schema);
    const file = await drive.update(target.fileId, await pack(state));
    save({ md5: file.md5Checksum ?? null, sites: state.sites });
  }

  /** One round with the file: take in what changed there, then send what it lacks. */
  async function round(drive: Drive, target: SyncTarget) {
    const file = await drive.meta(target.fileId);
    if (file.trashed) throw new SyncSetupError(`"${file.name}" is in the trash in Google Drive. Take it out, or stop syncing and start again.`);
    let merged = 0;
    let remoteSites = settings?.sites ?? {};
    if (file.md5Checksum !== settings?.md5) {
      const remote = await fetchState(drive, file);
      merged = mergeState(db, clock, remote, schema).changed;
      remoteSites = remote.sites;
      save({ md5: file.md5Checksum ?? null, sites: remote.sites });
    }
    let uploaded = false;
    if (missingMine(db, clock, { v: 1, schema, sites: remoteSites, tables: {} })) {
      await upload(drive, target);
      uploaded = true;
    }
    save({ syncedAt: Date.now(), error: null });
    return { merged, uploaded };
  }

  const failed = (err: unknown) => {
    const message =
      err instanceof DriveAuthError
        ? 'Google needs you to sign in again.'
        : err instanceof NewerSchema
          ? 'Another device has a newer Amble. Update this one to keep syncing.'
          : err instanceof SyncSetupError || err instanceof DriveError
            ? err.message
            : "Couldn't reach Google Drive.";
    if (settings?.target) save({ error: message });
    return message;
  };

  const service = {
    site,
    clock,

    /** Gives this copy's waiting changes their time; call it after every request that writes. */
    stamp() {
      if (settings?.target) stamp(db, clock);
    },

    status(): SyncStatus {
      const on = settings?.target != null;
      return {
        on,
        target: settings?.target ?? null,
        account: settings?.account ?? null,
        syncedAt: settings?.syncedAt ? new Date(settings.syncedAt).toISOString() : null,
        error: settings?.error ?? null,
        waiting: on && missingMine(db, clock, { v: 1, schema, sites: settings?.sites ?? {}, tables: {} }),
      };
    },

    /**
     * Starts syncing with a Google account: its own hidden copy ("personal"), a new household file
     * this account makes ("create"), or a household file someone shared that they picked ("join").
     * Whatever's already in the file comes in first, then this copy's own data goes out.
     */
    connect(token: string, how: { mode: 'personal' } | { mode: 'create'; name: string } | { mode: 'join'; fileId: string }) {
      return serial(async () => {
        const drive = createDrive(token, fetchImpl);
        const { user } = await drive.about();
        if (!user.emailAddress) throw new SyncSetupError("Google didn't say which account this is.");
        const account = { email: user.emailAddress.toLowerCase(), name: user.displayName ?? null };

        let file: DriveFile | undefined;
        let kind: SyncTarget['kind'] = 'personal';
        if (how.mode === 'personal') {
          [file] = await drive.find(`name = '${PERSONAL_FILE}'`, true);
        } else if (how.mode === 'join') {
          kind = 'household';
          file = await drive.meta(how.fileId).catch(() => undefined);
          if (!file || file.appProperties?.[HOUSEHOLD_PROPERTY.key] !== HOUSEHOLD_PROPERTY.value) {
            throw new SyncSetupError("That isn't an Amble household file. Pick the one shared with you, named like “Amble household”.");
          }
          if (file.capabilities?.canEdit === false) throw new SyncSetupError('That household file is shared with you to view only. Ask whoever shared it to let you edit.');
        } else kind = 'household';

        const localGroups = new Set(db.select({ id: groups.id }).from(groups).all().map((g) => g.id));
        startCapture(db);
        let remote: SyncState | null = null;
        if (file) {
          remote = await fetchState(drive, file);
          mergeState(db, clock, remote, schema);
        }
        adopt?.(account, localGroups, remote);

        if (!file) {
          const state = exportState(db, clock, schema);
          file =
            how.mode === 'personal'
              ? await drive.create({ name: PERSONAL_FILE, parents: ['appDataFolder'] }, await pack(state))
              : await drive.create(
                  {
                    name: how.mode === 'create' ? how.name : 'Amble household',
                    mimeType: HOUSEHOLD_MIME,
                    appProperties: { [HOUSEHOLD_PROPERTY.key]: HOUSEHOLD_PROPERTY.value },
                    description: "Amble keeps your household's tasks and lists in step through this file. Leave it here; Amble reads and writes it.",
                  },
                  await pack(state),
                );
          save({ md5: file.md5Checksum ?? null, sites: state.sites });
        } else {
          save({ md5: file.md5Checksum ?? null, sites: remote?.sites ?? {} });
        }
        const target: SyncTarget = { kind, fileId: file.id, name: file.name, owner: file.owners?.[0]?.emailAddress?.toLowerCase() ?? null };
        save({ target, account, error: null });
        await round(drive, target);
        return service.status();
      }).catch((err) => {
        if (err instanceof SyncSetupError) throw err;
        throw new SyncSetupError(failed(err));
      });
    },

    /** One round of sync. Returns how many rows changed here, so the app knows to refresh. */
    run(token: string) {
      return serial(async () => {
        const target = settings?.target;
        if (!target) return { merged: 0, uploaded: false, error: null as string | null };
        try {
          return { ...(await round(createDrive(token, fetchImpl), target)), error: null };
        } catch (err) {
          return { merged: 0, uploaded: false, error: failed(err) };
        }
      });
    },

    /** Household files this Google account made or picked, for choosing one to join. */
    async households(token: string) {
      const drive = createDrive(token, fetchImpl);
      return drive.find(`appProperties has { key='${HOUSEHOLD_PROPERTY.key}' and value='${HOUSEHOLD_PROPERTY.value}' }`);
    },

    /** Who the household file is shared with. */
    async people(token: string) {
      const target = settings?.target;
      if (target?.kind !== 'household') return [];
      return createDrive(token, fetchImpl).permissions(target.fileId);
    },

    /**
     * Shares the household file with someone's Google account, and adds them to the household so
     * tasks can go to them before they've joined. Google emails them a link.
     */
    async share(token: string, email: string, name: string, from: string) {
      const target = settings?.target;
      if (target?.kind !== 'household') throw new SyncSetupError('Make a household first, then share it.');
      const address = email.trim().toLowerCase();
      await createDrive(token, fetchImpl).share(
        target.fileId,
        address,
        `${from} is sharing their Amble household with you. Open Amble, choose “Join a household”, and pick this file.`,
      );
      if (!db.select().from(members).where(eq(members.email, address)).get()) {
        const timezone = db.select({ tz: members.timezone }).from(members).get()?.tz ?? 'UTC';
        db.insert(members).values({ email: address, name: name.trim() || address.split('@')[0]!, timezone }).run();
      }
      service.stamp();
    },

    /** Stops syncing this copy. The Drive file stays, for other devices and for coming back. */
    off() {
      return serial(async () => {
        stopCapture(db);
        save({ target: null, account: null, md5: null, sites: {}, syncedAt: null, error: null });
      });
    },
  };
  return service;
}

export type SyncService = ReturnType<typeof createSyncService>;

/**
 * Moves everything one member did or owns onto another, then removes the first: for a device that
 * started on its own and then joins a household its person was already in.
 */
export function adoptMember(db: Db, from: string, to: string) {
  if (from === to) return;
  const client = db.$client;
  db.transaction(() => {
    const tablesList = client.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[];
    for (const { name } of tablesList) {
      const keys = client.prepare(`PRAGMA foreign_key_list("${name}")`).all() as { table: string; from: string }[];
      for (const k of keys.filter((k) => k.table === 'members')) {
        // A row that would clash (the same day, or a reminder on the same task) gives way to theirs.
        client.prepare(`UPDATE OR IGNORE "${name}" SET "${k.from}" = ? WHERE "${k.from}" = ?`).run(to, from);
        client.prepare(`DELETE FROM "${name}" WHERE "${k.from}" = ?`).run(from);
      }
    }
    client.prepare(`DELETE FROM members WHERE id = ?`).run(from);
  });
}

/**
 * When a device joins, groups it made on its own that the household already has by name (the
 * starter groups both began with) fold into the household's, with everything in them.
 */
export function foldDuplicateGroups(db: Db, localOnly: Set<string>) {
  const all = db.select().from(groups).all();
  const key = (g: (typeof all)[number]) => `${g.kind}|${g.name.trim().toLowerCase()}|${g.privateTo ?? ''}`;
  const theirs = new Map(all.filter((g) => !localOnly.has(g.id) && !g.archivedAt).map((g) => [key(g), g.id]));
  db.transaction(() => {
    for (const g of all.filter((g) => localOnly.has(g.id))) {
      const into = theirs.get(key(g));
      if (!into) continue;
      db.update(tasks).set({ groupId: into }).where(eq(tasks.groupId, g.id)).run();
      db.update(tasks).set({ listId: into }).where(eq(tasks.listId, g.id)).run();
      db.update(listItems).set({ groupId: into }).where(eq(listItems.groupId, g.id)).run();
      db.delete(groups).where(eq(groups.id, g.id)).run();
    }
  });
}
