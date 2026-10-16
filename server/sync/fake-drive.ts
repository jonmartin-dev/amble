// A stand-in for Google Drive, for tests and for trying sync without a Google account. It answers
// the calls server/sync/drive.ts makes, for several people at once (one token each), and follows
// the drive.file rule: Amble sees a file only if it made it for that person, or they picked it.

interface FakeFile {
  id: string;
  name: string;
  owner: string;
  appData: boolean;
  bytes: Uint8Array;
  md5: string;
  modified: number;
  appProperties: Record<string, string>;
  properties: Record<string, string>;
  /** Writers by email; the owner is one. */
  writers: Map<string, string>;
  /** People whose Amble can open it: its maker, and anyone who picked it. */
  opened: Set<string>;
}

const digest = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

export function createFakeDrive() {
  const users = new Map<string, { email: string; name: string }>();
  const files = new Map<string, FakeFile>();
  let next = 0;
  /** Sharing emails Google would have sent. */
  const sent: { to: string; fileId: string; message: string }[] = [];

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fail = (status: number, message: string) => json({ error: { code: status, message } }, status);

  function view(f: FakeFile, email: string) {
    return {
      id: f.id,
      name: f.name,
      md5Checksum: f.md5,
      modifiedTime: new Date(f.modified).toISOString(),
      size: String(f.bytes.length),
      trashed: false,
      appProperties: f.appProperties,
      properties: f.properties,
      owners: [{ emailAddress: f.owner, displayName: users.get(f.owner)?.name ?? f.owner }],
      capabilities: { canEdit: f.writers.has(email), canShare: f.owner === email },
    };
  }

  const visible = (f: FakeFile, email: string) => (f.appData ? f.owner === email : f.opened.has(email) && f.writers.has(email));

  async function save(f: FakeFile, bytes: Uint8Array) {
    f.bytes = bytes;
    f.md5 = await digest(bytes);
    f.modified = Date.now();
  }

  /** Splits a multipart/related upload into its JSON part and its bytes. */
  function parts(body: Uint8Array, type: string) {
    const boundary = /boundary=([^;]+)/.exec(type)?.[1] ?? '';
    const text = new TextDecoder('latin1').decode(body);
    const [, metaPart, filePart] = text.split(`--${boundary}`);
    const meta = JSON.parse(metaPart!.split('\r\n\r\n')[1]!.trim()) as { name: string; parents?: string[]; appProperties?: Record<string, string> };
    const start = text.indexOf('\r\n\r\n', text.indexOf(filePart!)) + 4;
    const end = text.lastIndexOf(`\r\n--${boundary}--`);
    return { meta, bytes: body.slice(start, end) };
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
    const user = users.get(token);
    if (!user) return fail(401, 'Request had invalid authentication credentials.');
    const me = user.email;
    const path = url.pathname.replace(/^\/(upload\/)?drive\/v3/, '');
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : new Uint8Array();

    if (path === '/about') return json({ user: { displayName: user.name, emailAddress: me } });

    if (path === '/files' && method === 'GET') {
      const q = url.searchParams.get('q') ?? '';
      const appData = url.searchParams.get('spaces') === 'appDataFolder';
      const name = /name = '([^']+)'/.exec(q)?.[1];
      const prop = /appProperties has \{ key='([^']+)' and value='([^']+)' \}/.exec(q);
      const found = [...files.values()].filter(
        (f) => f.appData === appData && visible(f, me) && (!name || f.name === name) && (!prop || f.appProperties[prop[1]!] === prop[2]),
      );
      return json({ files: found.map((f) => view(f, me)) });
    }

    if (path === '/files' && method === 'POST') {
      const { meta, bytes } = parts(body, new Headers(init?.headers).get('content-type') ?? '');
      const appData = meta.parents?.includes('appDataFolder') ?? false;
      const f: FakeFile = {
        id: `file${++next}`,
        name: meta.name,
        owner: me,
        appData,
        bytes,
        md5: '',
        modified: 0,
        appProperties: meta.appProperties ?? {},
        properties: {},
        writers: new Map([[me, user.name]]),
        opened: new Set([me]),
      };
      await save(f, bytes);
      files.set(f.id, f);
      return json(view(f, me));
    }

    const fileMatch = /^\/files\/([^/]+)(\/permissions(?:\/([^/]+))?)?$/.exec(path);
    const f = fileMatch ? files.get(decodeURIComponent(fileMatch[1]!)) : undefined;
    if (!fileMatch) return fail(404, `No route for ${path}`);
    if (!f || !visible(f, me)) return fail(404, `File not found: ${fileMatch[1]}.`);

    if (fileMatch[2]) {
      if (method === 'GET') return json({ permissions: [...f.writers].map(([email, name], i) => ({ id: `perm${i}`, type: 'user', role: email === f.owner ? 'owner' : 'writer', emailAddress: email, displayName: name })) });
      if (f.owner !== me) return fail(403, 'The user does not have sufficient permissions for this file.');
      if (method === 'POST') {
        const { emailAddress } = JSON.parse(new TextDecoder().decode(body)) as { emailAddress: string };
        f.writers.set(emailAddress.toLowerCase(), users.get(emailAddress)?.name ?? '');
        sent.push({ to: emailAddress, fileId: f.id, message: url.searchParams.get('emailMessage') ?? '' });
        return json({ id: `perm${f.writers.size - 1}`, type: 'user', role: 'writer', emailAddress });
      }
      if (method === 'DELETE') {
        const email = [...f.writers.keys()][Number(fileMatch[3]?.replace('perm', ''))];
        if (email && email !== f.owner) f.writers.delete(email);
        return new Response(null, { status: 204 });
      }
    }
    if (method === 'GET' && url.searchParams.get('alt') === 'media') return new Response(f.bytes as BodyInit);
    if (method === 'GET') return json(view(f, me));
    if (method === 'PATCH') {
      if (!f.writers.has(me)) return fail(403, 'The user does not have sufficient permissions for this file.');
      // To the upload address, new contents; to the file's own, new details.
      if (url.pathname.startsWith('/upload/')) await save(f, body);
      else Object.assign(f.properties, (JSON.parse(new TextDecoder().decode(body)) as { properties?: Record<string, string> }).properties);
      return json(view(f, me));
    }
    return fail(405, 'Not allowed.');
  };

  return {
    fetch: fetchImpl,
    sent,
    /** Someone with a Google account; their token is the one Amble gets after they say yes. */
    user(email: string, name: string) {
      const token = `token-${email}`;
      users.set(token, { email, name });
      return token;
    },
    /** What choosing a file in Google's picker does: Amble can open it for that person from now on. */
    pick(email: string, fileId: string) {
      files.get(fileId)?.opened.add(email);
    },
    files: () => [...files.values()].map((f) => ({ id: f.id, name: f.name, owner: f.owner, appData: f.appData, size: f.bytes.length })),
    /** Someone renaming the file in Drive. */
    rename(fileId: string, name: string) {
      const f = files.get(fileId);
      if (f) f.name = name;
    },
  };
}

export type FakeDrive = ReturnType<typeof createFakeDrive>;
