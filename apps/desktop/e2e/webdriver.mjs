/**
 * Minimal W3C WebDriver client (classic protocol) for the desktop UI tests: just the commands they use, over fetch,
 * so the tests need no WebDriver library (and its browser-download dependency tree).
 */
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
export const Keys = { End: String.fromCharCode(0xe010), Enter: String.fromCharCode(0xe007) }; // WebDriver key codes

async function call(base, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.value?.error) throw new Error(`${method} ${path}: ${json.value?.error ?? res.status} ${json.value?.message ?? ''}`);
  return json.value;
}

/** CSS selectors as is; selectors starting with `/` or `(` are XPath. */
const locator = (sel) => (sel.startsWith('/') || sel.startsWith('(') ? { using: 'xpath', value: sel } : { using: 'css selector', value: sel });

class Element {
  constructor(s, id) {
    this.s = s;
    this.id = id;
  }
  click() {
    return this.s.cmd('POST', `/element/${this.id}/click`, {});
  }
  async setValue(text) {
    await this.s.cmd('POST', `/element/${this.id}/clear`, {});
    await this.s.cmd('POST', `/element/${this.id}/value`, { text });
  }
  type(text) {
    return this.s.cmd('POST', `/element/${this.id}/value`, { text });
  }
  getText() {
    return this.s.cmd('GET', `/element/${this.id}/text`);
  }
  isDisplayed() {
    return this.s.cmd('GET', `/element/${this.id}/displayed`);
  }
}

export class Session {
  static async create(base, capabilities) {
    const v = await call(base, 'POST', '/session', { capabilities: { alwaysMatch: capabilities } });
    return new Session(base, v.sessionId);
  }
  constructor(base, id) {
    this.base = base;
    this.id = id;
  }
  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }
  execute(fn, ...args) {
    return this.cmd('POST', '/execute/sync', { script: `return (${fn}).apply(null, arguments)`, args });
  }
  /** The first matching element, or null. */
  async find(sel) {
    const all = await this.findAll(sel);
    return all[0] ?? null;
  }
  async findAll(sel) {
    const v = await this.cmd('POST', '/elements', locator(sel));
    return v.map((e) => new Element(this, e[ELEMENT]));
  }
  /** Waits until `sel` matches a displayed element and returns it. */
  async $(sel, ms = 15_000) {
    const end = Date.now() + ms;
    let last = null;
    while (Date.now() < end) {
      try {
        const el = await this.find(sel);
        if (el && (await el.isDisplayed())) return el;
      } catch (e) {
        last = e; // element went stale while re-rendering
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    const page = await this.execute(() => document.body.innerText).catch(() => '');
    throw new Error(`no visible element for ${sel}${last ? ` (${last.message})` : ''}\n${String(page).slice(0, 2000)}`);
  }
  close() {
    return call(this.base, 'DELETE', `/session/${this.id}`);
  }
}
