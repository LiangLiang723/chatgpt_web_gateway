export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 16;
export const MAX_TOTAL_ATTACHMENT_BYTES_PER_REQUEST = 64 * 1024 * 1024;
export const MAX_REMOTE_REDIRECTS = 5;
export const REMOTE_CONNECT_TIMEOUT_MS = 10_000;
export const REMOTE_TOTAL_TIMEOUT_MS = 30_000;

export const FILE_PURPOSES = [
  'assistants',
  'batch',
  'fine-tune',
  'vision',
  'user_data',
  'evals',
] as const;

export type FilePurpose = (typeof FILE_PURPOSES)[number];

export function isFilePurpose(value: string): value is FilePurpose {
  return (FILE_PURPOSES as readonly string[]).includes(value);
}

export function isSafeLogicalFilename(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
  }
  return Buffer.byteLength(value, 'utf8') <= 255;
}
