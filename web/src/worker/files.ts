// File bytes on the device, in the browser's private file system (OPFS) under files/<sha256>.
// Uploads are hashed in memory (they're at most 25 MB) and written once, so a cut-off upload never
// leaves part of a file behind.
import { DomainError } from '../../../server/domain/household.ts';
import { FileTooBig, tooBigMessage, type FileStore } from '../../../server/domain/files.ts';

// Only workers have synchronous file access; the DOM typings leave it out.
interface SyncAccess {
  write(data: BufferSource, options?: { at: number }): number;
  flush(): void;
  close(): void;
}
const syncAccess = (file: FileSystemFileHandle) => (file as unknown as { createSyncAccessHandle(): Promise<SyncAccess> }).createSyncAccessHandle();

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function createOpfsFiles(folder = 'files'): Promise<FileStore> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(folder, { create: true });

  async function read(body: ReadableStream<Uint8Array>, limit: number) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new FileTooBig(tooBigMessage(limit));
      }
      chunks.push(value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.length;
    }
    return all;
  }

  const handle = async (sha256: string) => {
    if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
    return dir.getFileHandle(sha256).catch(() => null);
  };

  return {
    async save(body, limit) {
      if (!body) throw new DomainError('That file is empty.');
      const bytes = await read(body, limit);
      if (bytes.length === 0) throw new DomainError('That file is empty.');
      const sha256 = hex(await crypto.subtle.digest('SHA-256', bytes));
      if (!(await handle(sha256))) {
        // Written under a temporary name and moved into place, so a half-written file never has the real name.
        const temp = `tmp-${crypto.randomUUID()}`;
        const file = await dir.getFileHandle(temp, { create: true });
        const access = await syncAccess(file);
        try {
          access.write(bytes, { at: 0 });
          access.flush();
        } finally {
          access.close();
        }
        const movable = file as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
        if (movable.move) await movable.move(sha256);
        else {
          await dir.removeEntry(temp);
          const direct = await syncAccess(await dir.getFileHandle(sha256, { create: true }));
          try {
            direct.write(bytes, { at: 0 });
            direct.flush();
          } finally {
            direct.close();
          }
        }
      }
      return { sha256, size: bytes.length };
    },

    async get(sha256) {
      const h = await handle(sha256);
      if (!h) return null;
      const file = await h.getFile();
      return { size: file.size, stream: () => file.stream(), bytes: async () => new Uint8Array(await file.arrayBuffer()) };
    },

    async sweep(used, strayAfterMs, now) {
      let deleted = 0;
      for await (const [name, entry] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
        if (entry.kind !== 'file' || used.has(name)) continue;
        const file = await (entry as FileSystemFileHandle).getFile();
        if (now - file.lastModified < strayAfterMs) continue;
        await dir.removeEntry(name);
        deleted++;
      }
      return deleted;
    },
  };
}
