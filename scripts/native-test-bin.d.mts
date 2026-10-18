export function nativeTestBinary(example: 'rtc_cli' | 'tex_cli', suite?: string): string | null;
export function nativeSkip(suite: string, reason: string, enable: string, ctx?: { skip(note?: string): void }): void;
