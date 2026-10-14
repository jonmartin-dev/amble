import { describe, expect, it } from 'vitest';
import { clientSecretBasic } from './oidc.ts';

describe('clientSecretBasic', () => {
  it('form-encodes like a browser, leaving the - and . in Google client IDs alone', () => {
    const headers = new Headers();
    const auth = clientSecretBasic('a+b/c=d e~_*');
    auth({ issuer: 'https://accounts.google.com' }, { client_id: '123-abc.apps.googleusercontent.com' }, new URLSearchParams(), headers);
    const [id, secret] = atob(headers.get('authorization')!.replace(/^Basic /, '')).split(':');
    expect(id).toBe('123-abc.apps.googleusercontent.com');
    expect(secret).toBe('a%2Bb%2Fc%3Dd+e%7E_*');
    expect(new URLSearchParams(`s=${secret}`).get('s')).toBe('a+b/c=d e~_*');
  });
});
