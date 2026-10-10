import { type StoredDeviceKeys, generateDeviceKeys } from '@hivetex/crypto';
import { type Role, TICKET_TYP, type TrustedKey } from '@hivetex/protocol';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export class TestAuthority {
  trusted!: TrustedKey[];
  private priv!: CryptoKey;
  epoch = 1;
  now = () => new Date();

  static async create() {
    const a = new TestAuthority();
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    a.priv = privateKey;
    a.trusted = [{ kid: 'k1', jwk: { ...(await exportJWK(publicKey)), alg: 'EdDSA' } }];
    return a;
  }

  async mint(
    p: { pid: string; uid: string; uname: string; dev: string; keys: StoredDeviceKeys; role: Role; ep?: number },
    o: { ttlSec?: number; iat?: number } = {},
  ) {
    const iat = o.iat ?? Math.floor(this.now().getTime() / 1000);
    return new SignJWT({
      v: 1,
      pid: p.pid,
      uid: p.uid,
      uname: p.uname,
      dev: p.dev,
      devX: p.keys.xPub,
      devE: p.keys.edPub,
      role: p.role,
      ep: p.ep ?? this.epoch,
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1', typ: TICKET_TYP })
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.ttlSec ?? 900))
      .sign(this.priv);
  }
}

export interface TestIdentity {
  uid: string;
  uname: string;
  dev: string;
  keys: StoredDeviceKeys;
  role: Role;
}

let n = 0;
export async function identity(uname: string, role: Role): Promise<TestIdentity> {
  n++;
  return { uid: `u-${uname}`, uname, dev: `d-${uname}-${n}`, keys: await generateDeviceKeys(), role };
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 3000, step = 5) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await tick(step);
  }
  throw new Error('waitFor timed out');
}

import { Mesh } from './mesh.js';
import { ProjectModel } from './model.js';
import { MemoryPersistence, type Persistence } from './persistence.js';
import { loopbackPair } from './transport.js';

export interface Node {
  name: string;
  role: Role;
  model: ProjectModel;
  mesh: Mesh;
  store: Persistence;
  ticket: string;
  dev: string;
}

export class Net {
  nodes: Node[] = [];
  constructor(
    readonly auth: TestAuthority,
    readonly pid = 'proj1',
  ) {}

  static async create() {
    return new Net(await TestAuthority.create());
  }

  async add(name: string, role: Role, opts: { store?: Persistence; meshOpts?: object } = {}): Promise<Node> {
    const id = await identity(name, role);
    const ticket = await this.auth.mint({ pid: this.pid, uid: id.uid, uname: name, dev: id.dev, keys: id.keys, role });
    const store = opts.store ?? new MemoryPersistence();
    const model = new ProjectModel(store, { flushMs: 5 });
    await model.init();
    const mesh = new Mesh({
      projectId: this.pid,
      model,
      keys: id.keys,
      trusted: this.auth.trusted,
      getTicket: () => ticket,
      now: this.auth.now,
      ...opts.meshOpts,
    });
    const node: Node = { name, role, model, mesh, store, ticket, dev: id.dev };
    this.nodes.push(node);
    return node;
  }

  async link(a: Node, b: Node, transport: { immediate?: boolean; latencyMs?: number } = {}) {
    const [ta, tb] = loopbackPair(transport);
    const [pa, pb] = await Promise.all([a.mesh.addTransport(ta), b.mesh.addTransport(tb)]);
    return [pa, pb] as const;
  }

  async fullMesh(transport: { immediate?: boolean; latencyMs?: number } = {}) {
    for (let i = 0; i < this.nodes.length; i++)
      for (let j = i + 1; j < this.nodes.length; j++) await this.link(this.nodes[i] as Node, this.nodes[j] as Node, transport);
  }

  /** Disconnects every connection of a node. */
  isolate(n: Node) {
    for (const p of n.mesh.peers) p.conn.close();
  }

  destroy() {
    for (const n of this.nodes) n.mesh.destroy();
  }
}

export async function text(n: Node, fileId: string) {
  return (await n.model.openText(fileId)).toString();
}

export async function converged(nodes: Node[], fileId: string, ms = 3000) {
  for (const n of nodes) await n.mesh.openDoc(`f:${fileId}`);
  await waitFor(async () => {
    const t = await Promise.all(nodes.map((n) => text(n, fileId)));
    return t.every((x) => x === t[0]);
  }, ms);
}
