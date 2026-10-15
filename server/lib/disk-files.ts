// File bytes on the server's disk, at <data dir>/files/<ab>/<sha256>. An upload is written to a
// temporary file first, so a cut-off upload never leaves half a file in place.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DomainError } from '../domain/household.ts';
import { FileTooBig, tooBigMessage, type FileStore } from '../domain/files.ts';

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
        if (size > limit) return done(new FileTooBig(tooBigMessage(limit)));
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

  const store: FileStore & { root: string; pathOf: (sha256: string) => string } = {
    root,
    pathOf,
    save,

    async get(sha256) {
      if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
      const file = pathOf(sha256);
      if (!fs.existsSync(file)) return null;
      return {
        size: fs.statSync(file).size,
        stream: () => Readable.toWeb(fs.createReadStream(file)) as ReadableStream<Uint8Array>,
        bytes: async () => new Uint8Array(await fs.promises.readFile(file)),
      };
    },

    async sweep(used, strayAfterMs, now) {
      let deleted = 0;
      if (!fs.existsSync(root)) return deleted;
      for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const folder = path.join(root, dir.name);
        for (const name of fs.readdirSync(folder)) {
          if (dir.name !== 'tmp' && used.has(name)) continue;
          const file = path.join(folder, name);
          if (now - fs.statSync(file).mtimeMs < strayAfterMs) continue;
          fs.rmSync(file, { force: true });
          deleted++;
        }
      }
      return deleted;
    },
  };
  return store;
}

export type DiskFileStore = ReturnType<typeof createFileStore>;
