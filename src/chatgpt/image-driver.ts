import type { Locator, Page } from 'playwright';

import { createChatGptDriver, type ChatGptStreamingTextDriver } from './driver.js';
import { ChatGptDriverError, asChatGptDriverError } from './errors.js';
import { inspectCollection } from './selector-registry.js';
import { chatGptSelectors } from './selectors.js';

export interface GeneratedImageCandidate {
  index: number;
  src: string;
  visible: boolean;
  naturalWidth: number;
  naturalHeight: number;
}

export interface ChatGptImageDriver {
  generate(page: Page, prompt: string): Promise<Buffer>;
}

export interface CreateChatGptImageDriverOptions {
  textDriver?: ChatGptStreamingTextDriver;
  inspectCollection?: typeof inspectCollection;
  completionTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  readCandidates?: (
    generatedImages: Locator,
    baseline: number,
  ) => Promise<GeneratedImageCandidate[]>;
  fetchBytes?: (page: Page, source: string) => Promise<Buffer>;
}

export function buildImageGenerationPrompt(prompt: string): string {
  return `Create an image: ${prompt}`;
}

export function selectGeneratedImageCandidate(
  candidates: readonly GeneratedImageCandidate[],
): GeneratedImageCandidate {
  const eligible = candidates.filter(
    (candidate) =>
      candidate.src.length > 0 &&
      candidate.visible &&
      candidate.naturalWidth >= 256 &&
      candidate.naturalHeight >= 256,
  );
  const uniqueBySource = eligible.filter(
    (candidate, index) => eligible.findIndex((item) => item.src === candidate.src) === index,
  );
  if (uniqueBySource.length === 0) {
    throw new ChatGptDriverError({
      code: 'chatgpt_image_missing',
      message: 'ChatGPT completed without one readable generated image',
    });
  }
  if (uniqueBySource.length > 1) {
    throw new ChatGptDriverError({
      code: 'chatgpt_image_ambiguous',
      message: 'ChatGPT completed with multiple distinct generated image resources',
    });
  }
  return uniqueBySource[0]!;
}

async function defaultReadCandidates(
  generatedImages: Locator,
  baseline: number,
): Promise<GeneratedImageCandidate[]> {
  const candidates = await generatedImages.evaluateAll((elements) =>
    elements.map((element, index) => {
      const image = element as HTMLImageElement;
      const rect = image.getBoundingClientRect();
      const style = window.getComputedStyle(image);
      return {
        index,
        src: image.currentSrc || image.src || '',
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0',
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      };
    }),
  );
  return candidates.slice(baseline);
}

async function fetchInPage(page: Page, source: string): Promise<Buffer> {
  const bytes = await page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Image fetch returned ${response.status}`);
    return Array.from(new Uint8Array(await response.arrayBuffer()));
  }, source);
  return Buffer.from(bytes);
}

async function defaultFetchBytes(page: Page, source: string): Promise<Buffer> {
  try {
    const url = new URL(source, page.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const response = await page.context().request.get(url.href, { timeout: 120_000 });
      if (!response.ok()) {
        throw new Error(`Image fetch returned ${response.status()}`);
      }
      return await response.body();
    }
    if (url.protocol === 'blob:' || url.protocol === 'data:') {
      return await fetchInPage(page, source);
    }
    throw new Error(`Unsupported generated image URL protocol: ${url.protocol}`);
  } catch (error) {
    throw new ChatGptDriverError({
      code: 'chatgpt_image_fetch_failed',
      message: 'ChatGPT generated image bytes could not be fetched',
      cause: error,
    });
  }
}

export function createChatGptImageDriver(
  options: CreateChatGptImageDriverOptions = {},
): ChatGptImageDriver {
  const textDriver = options.textDriver ?? createChatGptDriver();
  const inspectCollectionSelector = options.inspectCollection ?? inspectCollection;
  const completionTimeoutMs = options.completionTimeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readCandidates = options.readCandidates ?? defaultReadCandidates;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;

  return {
    async generate(page, prompt) {
      let turn: Awaited<ReturnType<ChatGptStreamingTextDriver['startText']>> | undefined;
      try {
        await textDriver.openFresh(page);
        const generatedImages = await inspectCollectionSelector(
          page,
          chatGptSelectors.generatedImages,
        );
        const baseline = generatedImages.count;
        turn = await textDriver.startText(page, { prompt: buildImageGenerationPrompt(prompt) });

        const startedAt = now();
        while (now() - startedAt <= completionTimeoutMs) {
          try {
            const candidate = selectGeneratedImageCandidate(
              await readCandidates(generatedImages.locator, baseline),
            );
            return await fetchBytes(page, candidate.src);
          } catch (error) {
            if (!(error instanceof ChatGptDriverError) || error.code !== 'chatgpt_image_missing') {
              throw error;
            }
          }
          await sleep(pollIntervalMs);
        }

        await turn.stop().catch(() => undefined);
        throw new ChatGptDriverError({
          code: 'chatgpt_generation_timeout',
          message: 'ChatGPT did not expose a readable generated image before the timeout',
        });
      } catch (error) {
        throw asChatGptDriverError(error, 'ChatGPT image generation failed');
      }
    },
  };
}
