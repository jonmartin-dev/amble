import { describe, expect, it } from 'vitest';
import { joinLink, qrPath, serverFromCode } from './qr.ts';

describe('codes to join a server', () => {
  it('links to the app at the server, and reads the address back out', () => {
    expect(joinLink('https://home.example/amble')).toBe('https://home.example/amble/?join');
    expect(joinLink('http://192.168.1.20:18085/')).toBe('http://192.168.1.20:18085/?join');
    expect(serverFromCode('https://home.example/amble/?join')).toBe('https://home.example/amble');
    expect(serverFromCode('http://192.168.1.20:18085/?join')).toBe('http://192.168.1.20:18085');
    // Someone's own code with just the address works too.
    expect(serverFromCode(' amble.example.com ')).toBe('amble.example.com');
  });

  it('draws the code with a margin around it', () => {
    const { d, size } = qrPath(joinLink('https://media-server.tail3cfc4a.ts.net/amble'));
    // Version 3 or 4 for a link this long, plus four modules each side.
    expect(size).toBeGreaterThanOrEqual(29 + 8);
    expect(d.startsWith('M4 4h7v1h-7z')).toBe(true);
  });
});
