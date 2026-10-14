import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAi } from './ai/client.ts';
import { createApp } from './app.ts';
import { createOidc } from './auth/oidc.ts';
import { createSession } from './auth/sessions.ts';
import { config, type Config } from './config.ts';
import { openDatabase, type Db } from './db/index.ts';
import { attachments, members, type Member } from './db/schema.ts';
import { seedStarterGroups } from './db/seed.ts';
import { createFileStore, fileType, cleanName, sweepFiles, type FileStore } from './domain/files.ts';
import { createGroup } from './domain/household.ts';
import { completeTasks, createTasks, getTask } from './domain/tasks.ts';
import { planningDate } from './lib/dates.ts';

const ORIGIN = 'https://almanac.test';
const testConfig: Config = {
  ...config,
  production: false,
  publicUrl: ORIGIN,
  basePath: '',
  publicOrigin: ORIGIN,
  adminEmails: ['jon@example.com'],
  allowedEmails: ['jon@example.com', 'alex@example.com'],
  devLogin: false,
  oidc: { ...config.oidc, clientId: '', clientSecret: '' },
  ai: { ...config.ai, apiKey: '' },
  maxFileBytes: 64 * 1024,
};

// The smallest valid images of each kind the app may send as a preview.
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);

let db: Db;
let app: ReturnType<typeof createApp>;
let store: FileStore;
let dir: string;
let jon: Member;
let alex: Member;
const cookies = new Map<string, string>();

function as(member: Member) {
  if (!cookies.has(member.id)) cookies.set(member.id, `almanac_session=${createSession(db, member.id, 'test')}`);
  const request = (method: string, url: string, body?: BodyInit, headers: Record<string, string> = {}) =>
    app.request(`${ORIGIN}/api${url}`, { method, headers: { cookie: cookies.get(member.id)!, origin: ORIGIN, ...headers }, body });
  return {
    request,
    upload: async (taskId: string, name: string, bytes: Buffer, type = 'image/jpeg') => {
      const res = await request('POST', `/tasks/${taskId}/files?name=${encodeURIComponent(name)}`, new Uint8Array(bytes), {
        'content-type': type,
        'content-length': String(bytes.length),
      });
      return { status: res.status, json: await res.json() };
    },
  };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  seedStarterGroups(db);
  cookies.clear();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almanac-files-'));
  store = createFileStore(dir);
  jon = db.insert(members).values({ email: 'jon@example.com', name: 'Jon Martin', timezone: 'America/Chicago', role: 'admin' }).returning().get();
  alex = db.insert(members).values({ email: 'alex@example.com', name: 'Alex Martin', timezone: 'America/Chicago' }).returning().get();
  app = createApp({ db, config: testConfig, oidc: createOidc(testConfig), ai: createAi(testConfig), files: store });
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const task = (title = 'Fix the dishwasher') => createTasks(db, { member: jon, via: 'app' }, [{ title }])[0]!;

describe('files on tasks', () => {
  it('stores an upload under its hash and serves it back', async () => {
    const t = task();
    const { status, json } = await as(jon).upload(t.id, 'receipt.jpg', PHOTO);
    expect(status).toBe(201);
    expect(json.file).toMatchObject({ name: 'receipt.jpg', mime: 'image/jpeg', size: PHOTO.length, preview: false, addedById: jon.id });
    expect(getTask(db, jon, t.id).files).toHaveLength(1);

    const row = db.select().from(attachments).get()!;
    expect(fs.readFileSync(store.pathOf(row.sha256))).toEqual(PHOTO);

    const res = await as(alex).request('GET', `/files/${json.file.id}`);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PHOTO);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toBe(`inline; filename="receipt.jpg"; filename*=UTF-8''receipt.jpg`);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(res.headers.get('cache-control')).toContain('immutable');

    const again = await as(alex).request('GET', `/files/${json.file.id}`, undefined, { 'if-none-match': `"${row.sha256}"` });
    expect(again.status).toBe(304);
  });

  it('downloads anything a browser could run as a page', async () => {
    const t = task();
    const { json } = await as(jon).upload(t.id, 'page.html', Buffer.from('<script>alert(1)</script>'), 'text/html');
    const res = await as(jon).request('GET', `/files/${json.file.id}`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('keeps the same bytes once, and names files safely', async () => {
    const t = task();
    await as(jon).upload(t.id, 'a.jpg', PHOTO);
    await as(jon).upload(t.id, '../../etc/b.jpg', PHOTO);
    expect(getTask(db, jon, t.id).files.map((f) => f.name)).toEqual(['a.jpg', 'b.jpg']);
    expect(fs.readdirSync(path.join(store.root, db.select().from(attachments).get()!.sha256.slice(0, 2)))).toHaveLength(1);
    expect(cleanName('C:\\Users\\me\\scan.pdf')).toBe('scan.pdf');
    expect(cleanName('')).toBe('file');
    expect(fileType('', 'manual.PDF')).toBe('application/pdf');
    expect(fileType('application/octet-stream', 'notes.txt')).toBe('text/plain');
    expect(fileType('image/heic; foo=bar', 'x')).toBe('image/heic');
  });

  it('turns away files over the limit, and empty ones', async () => {
    const t = task();
    const big = await as(jon).upload(t.id, 'big.bin', Buffer.alloc(testConfig.maxFileBytes + 1), 'application/octet-stream');
    expect(big.status).toBe(413);
    expect(big.json.error).toMatch(/up to/);
    // A client that doesn't say how big it is gets cut off at the limit.
    const sneaky = await as(jon).request('POST', `/tasks/${t.id}/files?name=x.bin`, new Uint8Array(testConfig.maxFileBytes + 10), {
      'content-type': 'application/octet-stream',
    });
    expect(sneaky.status).toBe(413);
    expect((await as(jon).upload(t.id, 'empty.txt', Buffer.alloc(0), 'text/plain')).status).toBe(400);
    expect(getTask(db, jon, t.id).files).toEqual([]);
    expect(fs.readdirSync(path.join(store.root, 'tmp'))).toEqual([]);
  });

  it('adds a preview for photos and serves it', async () => {
    const t = task();
    const { json } = await as(jon).upload(t.id, 'photo.jpg', PHOTO);
    expect((await as(jon).request('GET', `/files/${json.file.id}/preview`)).status).toBe(404);
    const put = await as(jon).request('POST', `/files/${json.file.id}/preview`, new Uint8Array(WEBP), { 'content-type': 'image/webp' });
    expect(put.status).toBe(204);
    expect(getTask(db, jon, t.id).files[0]!.preview).toBe(true);
    const res = await as(jon).request('GET', `/files/${json.file.id}/preview`);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(WEBP);
    const wrong = await as(jon).request('POST', `/files/${json.file.id}/preview`, '<svg/>', { 'content-type': 'image/svg+xml' });
    expect(wrong.status).toBe(400);
  });

  it('removes a file, can bring it back, and says so in History', async () => {
    const t = task();
    const { json } = await as(jon).upload(t.id, 'manual.pdf', Buffer.from('%PDF-1.4 tiny'), 'application/pdf');
    expect((await as(jon).request('DELETE', `/files/${json.file.id}`)).status).toBe(204);
    expect(getTask(db, jon, t.id).files).toEqual([]);
    expect((await as(jon).request('GET', `/files/${json.file.id}`)).status).toBe(404);
    expect((await as(jon).request('POST', `/files/${json.file.id}/restore`)).status).toBe(204);
    const res = await as(jon).request('GET', `/files/${json.file.id}`);
    expect(res.headers.get('content-security-policy')).not.toContain('sandbox');
    const history = await (await as(jon).request('GET', `/tasks/${t.id}/activity`)).json();
    expect(history.entries.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['task.file_added', 'task.file_removed', 'task.file_restored']),
    );
  });

  it("hides files on someone else's private tasks", async () => {
    const mine = createGroup(db, { member: alex, via: 'app' }, { name: 'Gifts', private: true });
    const [secret] = createTasks(db, { member: alex, via: 'app' }, [{ title: 'Present for Jon', groupId: mine.id }]);
    const { json } = await as(alex).upload(secret!.id, 'idea.jpg', PHOTO);
    expect((await as(jon).request('GET', `/files/${json.file.id}`)).status).toBe(404);
    expect((await as(jon).request('DELETE', `/files/${json.file.id}`)).status).toBe(404);
    expect((await as(jon).upload(secret!.id, 'x.jpg', PHOTO)).status).toBe(400);
  });

  it("gives a repeating task's next one the same files", async () => {
    const [chore] = createTasks(db, { member: jon, via: 'app' }, [
      { title: 'Descale the kettle', plannedDate: planningDate(jon), repeat: { mode: 'schedule', every: 1, unit: 'month' } },
    ]);
    await as(jon).upload(chore!.id, 'how-to.jpg', PHOTO);
    completeTasks(db, { member: jon, via: 'app' }, [chore!.id]);
    const rows = db.select().from(attachments).all();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.sha256)).size).toBe(1);
  });

  it('sweeps out files removed over a week ago and bytes nothing uses', async () => {
    const t = task();
    const kept = (await as(jon).upload(t.id, 'keep.jpg', PHOTO)).json.file;
    const gone = (await as(jon).upload(t.id, 'old.txt', Buffer.from('old notes'), 'text/plain')).json.file;
    await as(jon).request('DELETE', `/files/${gone.id}`);
    const goneSha = db.select().from(attachments).all().find((a) => a.id === gone.id)!.sha256;
    const later = Date.now() + 8 * 24 * 60 * 60 * 1000;
    expect(sweepFiles(db, store, later)).toEqual({ purged: 1, deleted: 1 });
    expect(fs.existsSync(store.pathOf(goneSha))).toBe(false);
    expect(db.select().from(attachments).all().map((a) => a.id)).toEqual([kept.id]);
  });
});
