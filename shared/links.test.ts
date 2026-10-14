import { describe, expect, it } from 'vitest';
import { webLink } from './links.ts';

describe('webLink', () => {
  it('keeps a full link and fills in https:// for a bare one', () => {
    expect(webLink('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(webLink('  amazon.com/dp/B0123 ')).toBe('https://amazon.com/dp/B0123');
    expect(webLink('www.rei.com')).toBe('https://www.rei.com/');
    expect(webLink('shop.example.com:8443/cart')).toBe('https://shop.example.com:8443/cart');
    expect(webLink('HTTP://Example.com')).toBe('http://example.com/');
  });

  it("turns down what isn't a web page", () => {
    expect(webLink('')).toBeNull();
    expect(webLink(null)).toBeNull();
    expect(webLink('milk')).toBeNull();
    expect(webLink('ask at the counter')).toBeNull();
    expect(webLink('mailto:me@example.com')).toBeNull();
    expect(webLink('javascript:alert(1)')).toBeNull();
    expect(webLink('ftp://example.com/file')).toBeNull();
  });
});
