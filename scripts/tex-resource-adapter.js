// Prepended to the unchanged vendored worker at distribution-build time. Only the two kpathsea URL/ID lookups
// are patched. Resource bytes stay upstream originals. hivetexFiles is the generated basename -> SHA-256 catalog.
// kpathsea format IDs: https://github.com/TeX-Live/texlive-source/blob/trunk/texk/kpathsea/types.h
const hivetexHashes = new Set(Object.values(hivetexFiles));
self.hivetexResource = (key, pk = false) => {
  const [format, name, extra] = key.split('/');
  if (pk || !name || extra) return null; // Bitmap font generation is not part of this immutable resource set.
  const extensions = {
    3: ['.tfm'], 4: ['.afm'], 6: ['.bib'], 7: ['.bst'], 10: ['.fmt'], 11: ['.map'], 26: ['.tex'],
    30: ['.pro'], 32: ['.pfb', '.pfa'], 33: ['.vf'], 36: ['.ttf', '.ttc'], 39: ['.tec'],
    44: ['.enc'], 45: ['.cmap'], 46: ['.sfd'], 47: ['.otf'],
  };
  const candidates = [name, ...(extensions[format] || []).map(extension => name + extension)];
  // XeTeX records the resolved /tex/<hash> font path in XDV. The PDF worker needs that exact resource too.
  const fontHash = name.replace(/\.(otf|ttf|ttc|pfb|pfa)$/, '');
  if (hivetexHashes.has(fontHash)) return { id: fontHash, url: new URL('./files/' + fontHash, self.location.href).href };
  const found = candidates.find(candidate => Object.hasOwn(hivetexFiles, candidate));
  if (!found) { console.debug('TeX resource unavailable', key); return null; }
  const id = hivetexFiles[found];
  return { id, url: new URL('./files/' + id, self.location.href).href };
};
