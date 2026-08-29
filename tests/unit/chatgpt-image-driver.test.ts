import type { Locator, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';

import type { ChatGptStreamingTextDriver } from '../../src/chatgpt/driver.js';
import {
  buildImageGenerationPrompt,
  createChatGptImageDriver,
  selectGeneratedImageCandidate,
} from '../../src/chatgpt/image-driver.js';

describe('ChatGPT image driver helpers', () => {
  it('uses a minimal image-generation prompt without Gateway identity prose', () => {
    const prompt = buildImageGenerationPrompt('a blue robot');
    expect(prompt).toBe('Create an image: a blue robot');
    expect(prompt).not.toMatch(/gateway|agent|api|json/i);
  });

  it('tracks newly generated images independently of assistant role turns', async () => {
    const page = {} as Page;
    const generatedImages = {} as Locator;
    const textDriver = {
      openFresh: vi.fn(async () => undefined),
      startText: vi.fn(async () => ({
        observe: async () => ({ exists: false, text: '', completionMarkerPresent: false }),
        stop: async () => 'already_complete' as const,
        conversationUrl: async () => 'https://chatgpt.com/c/image-test',
      })),
    } as unknown as ChatGptStreamingTextDriver;
    const readCandidates = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          index: 1,
          src: 'https://chatgpt.com/generated/image-test.png',
          visible: true,
          naturalWidth: 1024,
          naturalHeight: 1024,
        },
      ]);
    const fetchBytes = vi.fn(async () => Buffer.from([1, 2, 3]));
    const driver = createChatGptImageDriver({
      textDriver,
      inspectCollection: async (_page, definition) => {
        expect(definition.name).toBe('generatedImages');
        return {
          status: 'collection',
          candidateName: 'generated-image-test',
          count: 1,
          locator: generatedImages,
        };
      },
      readCandidates,
      fetchBytes,
      sleep: async () => undefined,
      completionTimeoutMs: 100,
    });

    await expect(driver.generate(page, 'a blue robot')).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(textDriver.openFresh).toHaveBeenCalledWith(page);
    expect(textDriver.startText).toHaveBeenCalledWith(page, {
      prompt: 'Create an image: a blue robot',
    });
    expect(readCandidates).toHaveBeenNthCalledWith(1, generatedImages, 1);
    expect(readCandidates).toHaveBeenNthCalledWith(2, generatedImages, 1);
    expect(fetchBytes).toHaveBeenCalledWith(page, 'https://chatgpt.com/generated/image-test.png');
  });

  it('selects exactly one visible loaded large image', () => {
    expect(
      selectGeneratedImageCandidate([
        { index: 0, src: 'small', visible: true, naturalWidth: 64, naturalHeight: 64 },
        { index: 1, src: 'target', visible: true, naturalWidth: 1024, naturalHeight: 1024 },
        { index: 2, src: 'hidden', visible: false, naturalWidth: 1024, naturalHeight: 1024 },
      ]),
    ).toEqual({
      index: 1,
      src: 'target',
      visible: true,
      naturalWidth: 1024,
      naturalHeight: 1024,
    });
  });

  it('deduplicates repeated DOM copies of the same generated image resource', () => {
    expect(
      selectGeneratedImageCandidate([
        {
          index: 0,
          src: 'https://chatgpt.com/generated/same.png',
          visible: true,
          naturalWidth: 1024,
          naturalHeight: 1024,
        },
        {
          index: 1,
          src: 'https://chatgpt.com/generated/same.png',
          visible: true,
          naturalWidth: 1024,
          naturalHeight: 1024,
        },
      ]),
    ).toEqual({
      index: 0,
      src: 'https://chatgpt.com/generated/same.png',
      visible: true,
      naturalWidth: 1024,
      naturalHeight: 1024,
    });
  });

  it('returns stable missing/ambiguous errors for zero or multiple distinct resources', () => {
    expect(() => selectGeneratedImageCandidate([])).toThrowError(
      expect.objectContaining({ code: 'chatgpt_image_missing' }),
    );
    expect(() =>
      selectGeneratedImageCandidate([
        { index: 0, src: 'a', visible: true, naturalWidth: 512, naturalHeight: 512 },
        { index: 1, src: 'b', visible: true, naturalWidth: 512, naturalHeight: 512 },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'chatgpt_image_ambiguous' }));
  });
});
