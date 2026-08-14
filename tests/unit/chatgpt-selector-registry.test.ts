import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import {
  inspectCollection,
  inspectUnique,
  resolveUnique,
  type SelectorDefinition,
} from '../../src/chatgpt/selector-registry.js';

function locator(count: number): Locator {
  return { count: async () => count } as unknown as Locator;
}

const page = {} as Page;

function uniqueDefinition(counts: number[]): SelectorDefinition<'unique'> {
  return {
    name: 'composer',
    cardinality: 'unique',
    candidates: counts.map((count, index) => ({
      name: `candidate-${index + 1}`,
      locate: () => locator(count),
    })),
  };
}

function collectionDefinition(counts: number[]): SelectorDefinition<'collection'> {
  return {
    name: 'assistantTurns',
    cardinality: 'collection',
    candidates: counts.map((count, index) => ({
      name: `candidate-${index + 1}`,
      locate: () => locator(count),
    })),
  };
}

describe('ChatGPT selector registry', () => {
  it('resolves the primary unique candidate when it matches exactly once', async () => {
    const inspected = await inspectUnique(page, uniqueDefinition([1, 1]));

    expect(inspected).toMatchObject({
      status: 'unique',
      candidateName: 'candidate-1',
      count: 1,
    });
  });

  it('falls back only after a missing unique candidate', async () => {
    const inspected = await inspectUnique(page, uniqueDefinition([0, 1]));

    expect(inspected).toMatchObject({
      status: 'unique',
      candidateName: 'candidate-2',
    });
  });

  it('reports ambiguity immediately instead of hiding it with a fallback', async () => {
    const definition = uniqueDefinition([2, 1]);

    await expect(resolveUnique(page, definition)).rejects.toMatchObject({
      code: 'selector_ambiguous',
      selectorName: 'composer',
      candidateName: 'candidate-1',
    });
  });

  it('reports missing after all unique candidates have zero matches', async () => {
    await expect(resolveUnique(page, uniqueDefinition([0, 0]))).rejects.toMatchObject({
      code: 'selector_missing',
      selectorName: 'composer',
    });
  });

  it('allows collection selectors to have many or zero matches', async () => {
    expect(await inspectCollection(page, collectionDefinition([0, 3]))).toMatchObject({
      status: 'collection',
      candidateName: 'candidate-2',
      count: 3,
    });

    expect(await inspectCollection(page, collectionDefinition([0, 0]))).toMatchObject({
      status: 'collection',
      candidateName: 'candidate-1',
      count: 0,
    });
  });
});
