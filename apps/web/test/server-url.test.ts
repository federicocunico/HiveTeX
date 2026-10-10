import { describe, expect, it } from 'vitest';
import { parseServerUrl } from '../src/lib/api.js';

describe('server address (desktop sign-in screen)', () => {
  it('accepts https origins and strips paths', () => {
    expect(parseServerUrl('https://p2platex.example.com')).toBe('https://p2platex.example.com');
    expect(parseServerUrl(' https://p2p.vercel.app/api/x?y=1 ')).toBe('https://p2p.vercel.app');
    expect(parseServerUrl('p2p.vercel.app')).toBe('https://p2p.vercel.app'); // scheme added
  });
  it('allows plain http only for local development', () => {
    expect(parseServerUrl('http://localhost:3000')).toBe('http://localhost:3000');
    expect(parseServerUrl('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
    expect(() => parseServerUrl('http://example.com')).toThrow(/https/);
  });
  it('rejects other schemes and garbage', () => {
    expect(() => parseServerUrl('ftp://example.com')).toThrow(/https/);
    expect(() => parseServerUrl('https://')).toThrow(/server address/);
    expect(() => parseServerUrl('not a url at all')).toThrow(/server address/);
  });
});
