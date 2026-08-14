import type { Locator, Page } from 'playwright';

import { ChatGptDriverError } from './errors.js';

export type SelectorCardinality = 'unique' | 'collection';

export interface SelectorCandidate {
  readonly name: string;
  locate(page: Page): Locator;
}

export interface SelectorDefinition<T extends SelectorCardinality = SelectorCardinality> {
  readonly name: string;
  readonly cardinality: T;
  readonly candidates: readonly SelectorCandidate[];
}

export type UniqueSelectorInspection =
  | {
      status: 'unique';
      candidateName: string;
      count: 1;
      locator: Locator;
    }
  | {
      status: 'missing';
      count: 0;
    }
  | {
      status: 'ambiguous';
      candidateName: string;
      count: number;
    };

export interface CollectionSelectorInspection {
  status: 'collection';
  candidateName: string;
  count: number;
  locator: Locator;
}

function requireCandidate(definition: SelectorDefinition): SelectorCandidate {
  const candidate = definition.candidates[0];
  if (!candidate) {
    throw new ChatGptDriverError({
      code: 'selector_missing',
      message: `Selector definition ${definition.name} has no candidates`,
      selectorName: definition.name,
    });
  }
  return candidate;
}

export async function inspectUnique(
  page: Page,
  definition: SelectorDefinition<'unique'>,
): Promise<UniqueSelectorInspection> {
  requireCandidate(definition);
  for (const candidate of definition.candidates) {
    const locator = candidate.locate(page);
    const count = await locator.count();
    if (count === 1) {
      return { status: 'unique', candidateName: candidate.name, count: 1, locator };
    }
    if (count > 1) {
      return { status: 'ambiguous', candidateName: candidate.name, count };
    }
  }
  return { status: 'missing', count: 0 };
}

export async function resolveUnique(
  page: Page,
  definition: SelectorDefinition<'unique'>,
): Promise<{ locator: Locator; candidateName: string }> {
  const inspected = await inspectUnique(page, definition);
  if (inspected.status === 'unique') {
    return { locator: inspected.locator, candidateName: inspected.candidateName };
  }
  if (inspected.status === 'ambiguous') {
    throw new ChatGptDriverError({
      code: 'selector_ambiguous',
      message: `Selector ${definition.name} matched multiple elements`,
      selectorName: definition.name,
      candidateName: inspected.candidateName,
    });
  }
  throw new ChatGptDriverError({
    code: 'selector_missing',
    message: `Selector ${definition.name} was not found`,
    selectorName: definition.name,
  });
}

export async function inspectCollection(
  page: Page,
  definition: SelectorDefinition<'collection'>,
): Promise<CollectionSelectorInspection> {
  const first = requireCandidate(definition);
  let firstLocator: Locator | undefined;
  for (const candidate of definition.candidates) {
    const locator = candidate.locate(page);
    firstLocator ??= locator;
    const count = await locator.count();
    if (count > 0) {
      return { status: 'collection', candidateName: candidate.name, count, locator };
    }
  }
  return {
    status: 'collection',
    candidateName: first.name,
    count: 0,
    locator: firstLocator ?? first.locate(page),
  };
}

export function resolveCollection(
  page: Page,
  definition: SelectorDefinition<'collection'>,
): Locator {
  return requireCandidate(definition).locate(page);
}
