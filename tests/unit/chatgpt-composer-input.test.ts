import { Buffer } from 'node:buffer';

import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import {
  LARGE_MULTILINE_PASTE_THRESHOLD_BYTES,
  MAX_INSERT_CHUNK_BYTES,
  enterComposerPrompt,
} from '../../src/chatgpt/composer-input.js';

function harness() {
  const events: string[] = [];
  const composer = {
    evaluate: vi.fn(async (_callback: unknown, prompt: string) => {
      events.push(`paste:${prompt}`);
    }),
  } as unknown as Locator;
  const page = {
    keyboard: {
      insertText: vi.fn(async (text: string) => {
        events.push(`insert:${text}`);
      }),
      press: vi.fn(async (key: string) => {
        events.push(`press:${key}`);
      }),
    },
  } as unknown as Page;
  return { composer, page, events };
}

describe('enterComposerPrompt', () => {
  it('keeps single-line input on keyboard.insertText', async () => {
    const { composer, page, events } = harness();

    await enterComposerPrompt(page, composer, 'hello');

    expect(events).toEqual(['insert:hello']);
    expect(composer.evaluate).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('keeps ordinary multiline input on one ProseMirror text/plain paste transaction', async () => {
    const { composer, page, events } = harness();
    const prompt = 'first line\nsecond line\nthird line';

    await enterComposerPrompt(page, composer, prompt);

    expect(events).toEqual([`paste:${prompt}`]);
    expect(composer.evaluate).toHaveBeenCalledTimes(1);
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
  });

  it('avoids one large paste and preserves a Pi-sized multiline prompt through bounded keyboard input', async () => {
    const { composer, page, events } = harness();
    const system = '项目规则。'.repeat(
      Math.ceil((LARGE_MULTILINE_PASTE_THRESHOLD_BYTES + 4096) / Buffer.byteLength('项目规则。')),
    );
    const prompt = `lead\n${system}\nfinal`;

    await enterComposerPrompt(page, composer, prompt);

    expect(composer.evaluate).not.toHaveBeenCalled();
    expect(page.keyboard.press).toHaveBeenCalledTimes(2);
    expect(page.keyboard.press).toHaveBeenNthCalledWith(1, 'Shift+Enter');
    expect(page.keyboard.press).toHaveBeenNthCalledWith(2, 'Shift+Enter');

    const inserted = events
      .filter((event) => event.startsWith('insert:'))
      .map((event) => event.slice('insert:'.length));
    expect(inserted.length).toBeGreaterThan(3);
    for (const chunk of inserted) {
      expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(MAX_INSERT_CHUNK_BYTES);
    }
    expect(inserted.join('')).toBe(`lead${system}final`);
  });
});
