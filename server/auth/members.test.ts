import { describe, expect, it } from 'vitest';
import { config, type Config } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { members } from '../db/schema.ts';
import { upsertMember } from './members.ts';

const listed: Config = { ...config, adminEmails: ['sam@example.com'], allowedEmails: ['sam@example.com'] };

describe('signing in through the provider', () => {
  it('makes the admins on the list admins, and keeps the ones made with a code', () => {
    const db = openDatabase(':memory:');
    const kai = db.insert(members).values({ email: 'kai@example.com', name: 'Kai Ito', timezone: 'America/Chicago', role: 'admin' }).returning().get();
    const ali = db.insert(members).values({ email: 'ali@example.com', name: 'Ali Kim', timezone: 'America/Chicago' }).returning().get();

    expect(upsertMember(db, listed, { email: 'Sam@example.com', name: 'Sam Lee' })).toMatchObject({ email: 'sam@example.com', role: 'admin' });
    expect(upsertMember(db, listed, { email: kai.email })).toMatchObject({ id: kai.id, role: 'admin' });
    expect(upsertMember(db, listed, { email: ali.email })).toMatchObject({ id: ali.id, role: 'member' });
  });
});
