import { type StoredDeviceKeys, generateDeviceKeys } from '@hivetex/crypto';
import { api, isDesktop } from './api.js';
import { secure } from './secure.js';

/**
 * Per-user device identity. WebCrypto keys are stored as non-extractable CryptoKey objects in
 * IndexedDB (structured clone), so page scripts cannot read the private key bytes.
 */
interface Stored {
  keys: StoredDeviceKeys;
  deviceId: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('hivetex-device', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Desktop: private key seeds live in the OS credential store, never in IndexedDB or files. */
async function getDesktop(userId: string): Promise<Stored | undefined> {
  const raw = await secure.get(`device:${userId}`);
  if (!raw) return undefined;
  const j = JSON.parse(raw) as { edSeed: string; xSeed: string; edPub: string; xPub: string; deviceId: string | null };
  return { keys: { kind: 'noble', edSeed: unb64(j.edSeed), xSeed: unb64(j.xSeed), edPub: j.edPub, xPub: j.xPub }, deviceId: j.deviceId };
}

async function putDesktop(userId: string, v: Stored) {
  if (v.keys.kind !== 'noble') throw new Error('desktop keys must be raw seeds');
  await secure.set(`device:${userId}`, JSON.stringify({ edSeed: b64(v.keys.edSeed), xSeed: b64(v.keys.xSeed), edPub: v.keys.edPub, xPub: v.keys.xPub, deviceId: v.deviceId }));
}

async function get(userId: string): Promise<Stored | undefined> {
  if (isDesktop) return getDesktop(userId);
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('keys').objectStore('keys').get(userId);
    r.onsuccess = () => resolve(r.result as Stored | undefined);
    r.onerror = () => reject(r.error);
  });
}

async function put(userId: string, v: Stored) {
  if (isDesktop) return putDesktop(userId, v);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('keys', 'readwrite');
    tx.objectStore('keys').put(v, userId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns this browser's keys for the user, generating them on first use. */
export async function localKeys(userId: string): Promise<Stored> {
  const existing = await get(userId);
  if (existing) return existing;
  const fresh: Stored = { keys: await generateDeviceKeys(isDesktop ? { forceNoble: true } : {}), deviceId: null };
  await put(userId, fresh);
  return fresh;
}

/** Registers the public keys with the control plane (idempotent) and remembers the device id. */
export async function ensureRegistered(userId: string, label: string): Promise<{ keys: StoredDeviceKeys; deviceId: string }> {
  const s = await localKeys(userId);
  if (s.deviceId) return { keys: s.keys, deviceId: s.deviceId };
  const r = await api<{ deviceId: string }>('POST', '/devices', { ed25519Pub: s.keys.edPub, x25519Pub: s.keys.xPub, label });
  await put(userId, { keys: s.keys, deviceId: r.deviceId });
  return { keys: s.keys, deviceId: r.deviceId };
}

export async function forgetDevice(userId: string) {
  const s = await get(userId);
  if (s) await put(userId, { keys: s.keys, deviceId: null });
}
