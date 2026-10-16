// Files kept in memory, for tests: a stand-in for the server's disk or the browser's private file system.
import { FileTooBig, type FileStore } from '../domain/files.ts';

export function memoryFiles(): FileStore & { stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>();
  return {
    stored,
    async save(body, limit) {
      if (!body) throw new Error('empty');
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      if (bytes.length > limit) throw new FileTooBig('too big');
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      stored.set(sha256, bytes);
      return { sha256, size: bytes.length };
    },
    async get(sha256) {
      const bytes = stored.get(sha256);
      if (!bytes) return null;
      return { size: bytes.length, stream: () => new Blob([bytes as BlobPart]).stream(), bytes: async () => bytes };
    },
    async sweep(used) {
      let n = 0;
      for (const sha of stored.keys()) if (!used.has(sha) && stored.delete(sha)) n++;
      return n;
    },
  };
}
