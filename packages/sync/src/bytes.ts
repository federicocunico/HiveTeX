/** IndexedDB and jsdom can return byte arrays from another realm. `instanceof` is not a storage format check. */
export function isBytes(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]';
}
