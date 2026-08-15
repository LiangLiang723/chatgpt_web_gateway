import type { Locator, Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { probeAuth } from '../../src/chatgpt/auth.js';
import type { SelectorDefinition } from '../../src/chatgpt/selector-registry.js';

const page = {} as Page;

function locator(count: number): Locator {
  return {
    count: async () => count,
    waitFor: async () => {
      if (count === 0) throw new Error('timeout');
    },
  } as unknown as Locator;
}

function unique(name: string, counts: number[]): SelectorDefinition<'unique'> {
  return {
    name,
    cardinality: 'unique',
    candidates: counts.map((count, index) => ({
      name: `${name}-${index + 1}`,
      locate: () => locator(count),
    })),
  };
}

describe('ChatGPT auth probe', () => {
  it('reports authenticated when the composer is uniquely available', async () => {
    await expect(
      probeAuth(page, {
        composer: unique('composer', [1]),
        loginIndicator: unique('login', [0]),
      }),
    ).resolves.toEqual({ state: 'authenticated' });
  });

  it('waits for the composer to mount before reporting an unknown auth state', async () => {
    let composerCount = 0;
    const composer: SelectorDefinition<'unique'> = {
      name: 'composer',
      cardinality: 'unique',
      candidates: [
        {
          name: 'composer-delayed',
          locate: () =>
            ({
              count: async () => composerCount,
              waitFor: async () => {
                composerCount = 1;
              },
            }) as unknown as Locator,
        },
      ],
    };
    const loginIndicator: SelectorDefinition<'unique'> = {
      name: 'login',
      cardinality: 'unique',
      candidates: [
        {
          name: 'login-missing',
          locate: () =>
            ({
              count: async () => 0,
              waitFor: async () => {
                throw new Error('timeout');
              },
            }) as unknown as Locator,
        },
      ],
    };

    await expect(probeAuth(page, { composer, loginIndicator })).resolves.toEqual({
      state: 'authenticated',
    });
  });

  it('reports auth_required only when an explicit login indicator is unique', async () => {
    await expect(
      probeAuth(page, {
        composer: unique('composer', [0]),
        loginIndicator: unique('login', [1]),
      }),
    ).resolves.toEqual({ state: 'auth_required' });
  });

  it('reports unknown when neither composer nor login indicator can be observed', async () => {
    await expect(
      probeAuth(page, {
        composer: unique('composer', [0]),
        loginIndicator: unique('login', [0]),
      }),
    ).resolves.toEqual({
      state: 'unknown',
      reason: 'composer_and_login_indicator_missing',
    });
  });

  it('preserves selector ambiguity instead of misreporting auth_required', async () => {
    await expect(
      probeAuth(page, {
        composer: unique('composer', [2]),
        loginIndicator: unique('login', [1]),
      }),
    ).rejects.toMatchObject({
      code: 'selector_ambiguous',
      selectorName: 'composer',
    });
  });
});
