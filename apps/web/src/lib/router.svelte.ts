function parse(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, q] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(q ?? '') };
}

export const route = $state(parse());

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const r = parse();
    route.path = r.path;
    route.query = r.query;
  });
}

export function go(path: string) {
  location.hash = path;
}
