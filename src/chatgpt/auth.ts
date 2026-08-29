import type { Page } from 'playwright';

import { ChatGptDriverError } from './errors.js';
import { inspectCollection, inspectUnique, type SelectorDefinition } from './selector-registry.js';
import { composerSelector, loginIndicatorSelector } from './selectors.js';

export type ChatGptAuthState =
  { state: 'authenticated' } | { state: 'auth_required' } | { state: 'unknown'; reason: string };

export interface ChatGptAuthSelectors {
  composer: SelectorDefinition<'unique'>;
  loginIndicator: SelectorDefinition<'collection'>;
}

const defaultSelectors: ChatGptAuthSelectors = {
  composer: composerSelector,
  loginIndicator: loginIndicatorSelector,
};

function throwAmbiguous(definition: SelectorDefinition<'unique'>, candidateName: string): never {
  throw new ChatGptDriverError({
    code: 'selector_ambiguous',
    message: `Selector ${definition.name} matched multiple elements`,
    selectorName: definition.name,
    candidateName,
  });
}

async function inspectAuthState(
  page: Page,
  selectors: ChatGptAuthSelectors,
): Promise<ChatGptAuthState> {
  const composer = await inspectUnique(page, selectors.composer);
  if (composer.status === 'unique') return { state: 'authenticated' };
  if (composer.status === 'ambiguous') {
    throwAmbiguous(selectors.composer, composer.candidateName);
  }

  const login = await inspectCollection(page, selectors.loginIndicator);
  if (login.count > 0) return { state: 'auth_required' };

  return { state: 'unknown', reason: 'composer_and_login_indicator_missing' };
}

async function waitForAuthSignal(page: Page, selectors: ChatGptAuthSelectors): Promise<void> {
  const candidates = [...selectors.composer.candidates, ...selectors.loginIndicator.candidates];
  try {
    await Promise.any(
      candidates.map((candidate) =>
        candidate.locate(page).waitFor({ state: 'attached', timeout: 10_000 }),
      ),
    );
  } catch {
    // A second strict inspection below decides whether the page is still unknown.
  }
}

export async function probeAuth(
  page: Page,
  selectors: ChatGptAuthSelectors = defaultSelectors,
): Promise<ChatGptAuthState> {
  const initialState = await inspectAuthState(page, selectors);
  if (initialState.state !== 'unknown') return initialState;

  await waitForAuthSignal(page, selectors);
  return inspectAuthState(page, selectors);
}
