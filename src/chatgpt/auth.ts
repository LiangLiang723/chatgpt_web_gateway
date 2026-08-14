import type { Page } from 'playwright';

import { ChatGptDriverError } from './errors.js';
import { inspectUnique, type SelectorDefinition } from './selector-registry.js';
import { composerSelector, loginIndicatorSelector } from './selectors.js';

export type ChatGptAuthState =
  { state: 'authenticated' } | { state: 'auth_required' } | { state: 'unknown'; reason: string };

export interface ChatGptAuthSelectors {
  composer: SelectorDefinition<'unique'>;
  loginIndicator: SelectorDefinition<'unique'>;
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

export async function probeAuth(
  page: Page,
  selectors: ChatGptAuthSelectors = defaultSelectors,
): Promise<ChatGptAuthState> {
  const composer = await inspectUnique(page, selectors.composer);
  if (composer.status === 'unique') return { state: 'authenticated' };
  if (composer.status === 'ambiguous') {
    throwAmbiguous(selectors.composer, composer.candidateName);
  }

  const login = await inspectUnique(page, selectors.loginIndicator);
  if (login.status === 'unique') return { state: 'auth_required' };
  if (login.status === 'ambiguous') {
    throwAmbiguous(selectors.loginIndicator, login.candidateName);
  }

  return { state: 'unknown', reason: 'composer_and_login_indicator_missing' };
}
