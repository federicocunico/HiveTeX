import { describe, expect, it } from 'vitest';
import { DEFAULT_SERVER, parseServerUrl, resolveServer } from '../src/lib/api.js';

describe('server address (desktop sign-in screen)', () => {
  it('accepts https origins and strips paths', () => {
    expect(parseServerUrl('https://hivetex.example.com')).toBe('https://hivetex.example.com');
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

describe('which server the app uses', () => {
  const base = { desktop: true, stored: null, dev: false, buildDefault: undefined };
  it('desktop builds default to hivetex.vercel.app', () => {
    expect(resolveServer(base)).toBe(DEFAULT_SERVER);
    expect(DEFAULT_SERVER).toBe('https://hivetex.vercel.app');
  });
  it('a build can replace the default (forks, on-premise)', () => {
    expect(resolveServer({ ...base, buildDefault: 'https://latex.example.org/' })).toBe('https://latex.example.org');
  });
  it("the user's choice wins over the build default, also in development", () => {
    expect(resolveServer({ ...base, buildDefault: 'https://b.example', stored: 'https://mine.example' })).toBe('https://mine.example');
    expect(resolveServer({ ...base, dev: true, stored: 'https://mine.example' })).toBe('https://mine.example');
  });
  it('make dev goes through the dev server proxy', () => {
    expect(resolveServer({ ...base, dev: true, buildDefault: 'https://b.example' })).toBe('');
  });
  it('the web app always uses its own origin', () => {
    expect(resolveServer({ ...base, desktop: false, stored: 'https://mine.example' })).toBe('');
  });
});
