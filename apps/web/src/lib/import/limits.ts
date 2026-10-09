export const LIMITS = {
  /** Largest single extracted file; bigger files are skipped. */
  maxFile: 50 * 1024 * 1024,
  /** Largest total extracted size; bigger inputs are refused. */
  maxTotal: 500 * 1024 * 1024,
  /** Most entries in one input; more are refused. */
  maxEntries: 5000,
};

export interface ImportFile {
  path: string;
  bytes: Uint8Array;
}
