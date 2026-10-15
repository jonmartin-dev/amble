// The few Google Drive calls sync needs, over plain fetch with an access token. Amble asks only
// for drive.appdata (its own hidden folder in each person's Drive) and drive.file (files it made,
// or that someone picked for it), which Google counts as non-sensitive.

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.appdata', 'https://www.googleapis.com/auth/drive.file'];

/** A household file's type, so Google's picker can list just those. */
export const HOUSEHOLD_MIME = 'application/vnd.almanac.household';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const TIMEOUT_MS = 30_000;

export class DriveError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The access token was turned down: it ran out, or the person took Amble's access away. */
export class DriveAuthError extends DriveError {}

export interface DriveFile {
  id: string;
  name: string;
  md5Checksum?: string;
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  appProperties?: Record<string, string>;
  owners?: { emailAddress?: string; displayName?: string }[];
  capabilities?: { canEdit?: boolean; canShare?: boolean };
}

export interface DrivePermission {
  id: string;
  type: string;
  role: string;
  emailAddress?: string;
  displayName?: string;
}

const FILE_FIELDS = 'id,name,md5Checksum,modifiedTime,size,trashed,appProperties,owners(emailAddress,displayName),capabilities(canEdit,canShare)';

export function createDrive(token: string, fetchImpl: typeof fetch = fetch) {
  async function call(url: string, init: RequestInit = {}) {
    const res = await fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return res;
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = body?.error?.message ?? `Google Drive said ${res.status}.`;
    if (res.status === 401) throw new DriveAuthError(res.status, message);
    throw new DriveError(res.status, message);
  }
  const json = async <T>(url: string, init?: RequestInit) => (await (await call(url, init)).json()) as T;

  /** A multipart body: the file's details, then its bytes. */
  function multipart(meta: object, bytes: Uint8Array) {
    const boundary = `amble${crypto.randomUUID().replace(/-/g, '')}`;
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);
    return { body, type: `multipart/related; boundary=${boundary}` };
  }

  return {
    /** Who the token belongs to. */
    about: () => json<{ user: { displayName?: string; emailAddress?: string; photoLink?: string } }>(`${API}/about?fields=user(displayName,emailAddress,photoLink)`),

    /** Files Amble can see that match a Drive query, in its hidden folder or not. */
    async find(q: string, appData = false) {
      const params = new URLSearchParams({ q: `${q} and trashed = false`, fields: `files(${FILE_FIELDS})`, pageSize: '20' });
      if (appData) params.set('spaces', 'appDataFolder');
      return (await json<{ files: DriveFile[] }>(`${API}/files?${params}`)).files;
    },

    meta: (id: string) => json<DriveFile>(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`),

    async download(id: string) {
      return new Uint8Array(await (await call(`${API}/files/${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
    },

    async create(meta: { name: string; parents?: string[]; appProperties?: Record<string, string>; description?: string; mimeType?: string }, bytes: Uint8Array) {
      const { body, type } = multipart({ mimeType: 'application/octet-stream', ...meta }, bytes);
      return json<DriveFile>(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, { method: 'POST', headers: { 'content-type': type }, body: body as BodyInit });
    },

    async update(id: string, bytes: Uint8Array) {
      return json<DriveFile>(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${FILE_FIELDS}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes as BodyInit,
      });
    },

    /** Lets someone else's Google account edit a file. Google emails them a link to it. */
    share: (id: string, email: string, message: string) =>
      json<DrivePermission>(
        `${API}/files/${encodeURIComponent(id)}/permissions?${new URLSearchParams({ sendNotificationEmail: 'true', emailMessage: message, fields: 'id,type,role,emailAddress,displayName' })}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: email }) },
      ),

    async permissions(id: string) {
      return (await json<{ permissions: DrivePermission[] }>(`${API}/files/${encodeURIComponent(id)}/permissions?fields=permissions(id,type,role,emailAddress,displayName)`)).permissions;
    },

    unshare: async (id: string, permissionId: string) => {
      await call(`${API}/files/${encodeURIComponent(id)}/permissions/${encodeURIComponent(permissionId)}`, { method: 'DELETE' });
    },
  };
}

export type Drive = ReturnType<typeof createDrive>;

/** A state file's bytes: JSON, gzipped. */
export async function pack(value: unknown): Promise<Uint8Array> {
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unpack<T>(bytes: Uint8Array): Promise<T> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as T;
}
