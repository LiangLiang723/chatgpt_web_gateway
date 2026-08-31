import { Buffer } from 'node:buffer';

import type { Locator, Page } from 'playwright';

export const LARGE_MULTILINE_PASTE_THRESHOLD_BYTES = 16 * 1024;
export const MAX_INSERT_CHUNK_BYTES = 4 * 1024;

function splitUtf8Chunks(text: string, maxBytes: number): string[] {
  if (text.length === 0) return [];

  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (current.length > 0 && currentBytes + codePointBytes > maxBytes) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += codePoint;
    currentBytes += codePointBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function pasteMultiline(composer: Locator, prompt: string): Promise<void> {
  await composer.evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
        composed: true,
      }),
    );
  }, prompt);
}

async function insertLargeMultiline(page: Page, prompt: string): Promise<void> {
  const lines = prompt.split(/\r\n|\n|\r/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    for (const chunk of splitUtf8Chunks(lines[lineIndex]!, MAX_INSERT_CHUNK_BYTES)) {
      await page.keyboard.insertText(chunk);
    }
    if (lineIndex < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
}

export async function enterComposerPrompt(
  page: Page,
  composer: Locator,
  prompt: string,
): Promise<void> {
  if (!/[\r\n]/.test(prompt)) {
    await page.keyboard.insertText(prompt);
    return;
  }

  if (Buffer.byteLength(prompt) <= LARGE_MULTILINE_PASTE_THRESHOLD_BYTES) {
    await pasteMultiline(composer, prompt);
    return;
  }

  await insertLargeMultiline(page, prompt);
}
