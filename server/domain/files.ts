// Files on tasks. The bytes are stored once per content, at <data dir>/files/<ab>/<sha256>, and
// written to a temporary file first so a cut-off upload never leaves half a file in place. A
// removed file can be brought back for a week; after that, and once no task uses its bytes, a
// daily sweep deletes it.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { and, asc, eq, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.ts';
import { attachments, type Attachment } from '../db/schema.ts';
import { DomainError, logActivity, type Actor } from './household.ts';

export interface FileView {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** A smaller copy exists, for showing a photo without fetching all of it. */
  preview: boolean;
  addedById: string | null;
  createdAt: Date;
}

export class FileTooBig extends DomainError {}

const KEEP_REMOVED_MS = 7 * 24 * 60 * 60 * 1000;
// Bytes no row points at are left alone this long, in case an upload is still finishing.
const STRAY_AFTER_MS = 60 * 60 * 1000;

// Shown in the browser when opened; anything else downloads, so a file can't run as a page.
const INLINE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
]);

// For files the browser didn't name a type for.
const BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

/** A file name safe to store and to send back in a header: no folders, no control characters. */
export function cleanName(name: string | undefined | null) {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return clean || 'file';
}

/** The type to keep for a file: what the browser said, or a guess from its name. */
export function fileType(contentType: string | undefined, name: string) {
  const given = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (/^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(given) && given !== 'application/octet-stream') return given;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/** How to send a file back: shown in the browser for safe types, downloaded otherwise. */
export function servedAs(mime: string): { type: string; inline: boolean } {
  if (INLINE.has(mime)) return { type: mime === 'text/plain' ? 'text/plain; charset=utf-8' : mime, inline: true };
  return { type: 'application/octet-stream', inline: false };
}

export function createFileStore(dataDir: string) {
  const root = path.join(dataDir, 'files');
  const tmp = path.join(root, 'tmp');
  const pathOf = (sha256: string) => path.join(root, sha256.slice(0, 2), sha256);

  /** Streams an upload to disk, at most `limit` bytes, and files it under its hash. */
  async function save(body: ReadableStream<Uint8Array> | null, limit: number): Promise<{ sha256: string; size: number }> {
    if (!body) throw new DomainError('That file is empty.');
    fs.mkdirSync(tmp, { recursive: true });
    const temp = path.join(tmp, randomUUID());
    const hash = createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > limit) return done(new FileTooBig(`Files can be up to ${Math.round(limit / 1024 / 1024)} MB.`));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(body as WebReadableStream<Uint8Array>), meter, fs.createWriteStream(temp, { flags: 'wx' }));
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
    if (size === 0) {
      fs.rmSync(temp, { force: true });
      throw new DomainError('That file is empty.');
    }
    const sha256 = hash.digest('hex');
    const target = pathOf(sha256);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(temp, { force: true });
    else fs.renameSync(temp, target);
    return { sha256, size };
  }

  return { root, pathOf, save };
}

export type FileStore = ReturnType<typeof createFileStore>;

function view(a: Attachment): FileView {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, preview: a.previewSha256 != null, addedById: a.addedById, createdAt: a.createdAt };
}

/** Each task's files, oldest first, leaving out removed ones. */
export function attachmentsFor(db: Db, taskIds: string[]): Map<string, FileView[]> {
  const out = new Map<string, FileView[]>();
  if (taskIds.length === 0) return out;
  const rows = db
    .select()
    .from(attachments)
    .where(and(inArray(attachments.taskId, taskIds), isNull(attachments.removedAt)))
    .orderBy(asc(attachments.createdAt))
    .all();
  for (const a of rows) out.set(a.taskId, [...(out.get(a.taskId) ?? []), view(a)]);
  return out;
}

export function getAttachment(db: Db, id: string): Attachment | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).get();
}

export function addAttachment(db: Db, actor: Actor, taskId: string, file: { name: string; mime: string; sha256: string; size: number }): FileView {
  const row = db.transaction(() => {
    const inserted = db
      .insert(attachments)
      .values({ taskId, addedById: actor.member.id, ...file })
      .returning()
      .get();
    logActivity(db, actor, 'task.file_added', taskId, { name: file.name });
    return inserted;
  });
  return view(row);
}

export function setPreview(db: Db, id: string, sha256: string) {
  db.update(attachments).set({ previewSha256: sha256 }).where(eq(attachments.id, id)).run();
}

export function removeAttachment(db: Db, actor: Actor, a: Attachment, restore = false) {
  // Already removed, or already back.
  if ((a.removedAt != null) === !restore) return;
  db.transaction(() => {
    db.update(attachments)
      .set({ removedAt: restore ? null : new Date() })
      .where(eq(attachments.id, a.id))
      .run();
    logActivity(db, actor, restore ? 'task.file_restored' : 'task.file_removed', a.taskId, { name: a.name });
  });
}

/** A repeating task's next one keeps the same files, without storing the bytes twice. */
export function copyAttachments(db: Db, fromTaskId: string, toTaskId: string) {
  const rows = db
    .select()
    .from(attachments)
    .where(and(eq(attachments.taskId, fromTaskId), isNull(attachments.removedAt)))
    .all();
  for (const { id: _id, taskId: _task, createdAt: _at, ...rest } of rows) db.insert(attachments).values({ ...rest, taskId: toTaskId }).run();
}

/**
 * Deletes files removed more than a week ago, then any stored bytes no file points at anymore,
 * and leftovers from uploads that never finished.
 */
export function sweepFiles(db: Db, store: FileStore, now = Date.now()) {
  const purged = db
    .delete(attachments)
    .where(and(isNotNull(attachments.removedAt), lt(attachments.removedAt, new Date(now - KEEP_REMOVED_MS))))
    .run().changes;
  const used = new Set<string>();
  for (const a of db.select({ sha: attachments.sha256, preview: attachments.previewSha256 }).from(attachments).all()) {
    used.add(a.sha);
    if (a.preview) used.add(a.preview);
  }
  let deleted = 0;
  if (!fs.existsSync(store.root)) return { purged, deleted };
  for (const dir of fs.readdirSync(store.root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const folder = path.join(store.root, dir.name);
    for (const name of fs.readdirSync(folder)) {
      if (dir.name !== 'tmp' && used.has(name)) continue;
      const file = path.join(folder, name);
      if (now - fs.statSync(file).mtimeMs < STRAY_AFTER_MS) continue;
      fs.rmSync(file, { force: true });
      deleted++;
    }
  }
  return { purged, deleted };
}
