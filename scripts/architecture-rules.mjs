const rules = [
  {
    dir: 'api',
    forbidden: (value) =>
      value === 'playwright' || value.startsWith('playwright/') || /chatgpt\/selectors/.test(value),
    message: 'api/ must not import Playwright or ChatGPT selectors directly',
  },
  {
    dir: 'context',
    forbidden: (value) =>
      value === 'playwright' ||
      value.startsWith('playwright/') ||
      /(?:^|\/)api(?:\/|$)/.test(value) ||
      /(?:^|\/)chatgpt(?:\/|$)/.test(value) ||
      /(?:^|\/)persistence(?:\/|$)/.test(value),
    message: 'context/ must stay pure and independent from api/chatgpt/persistence/playwright',
  },
  {
    dir: 'stream',
    forbidden: (value) => /chatgpt\/selectors/.test(value),
    message: 'stream/ must not import ChatGPT selectors',
  },
  {
    dir: 'persistence',
    forbidden: (value) => value === 'playwright' || value.startsWith('playwright/'),
    message: 'persistence/ must not import Playwright',
  },
  {
    dir: 'browser',
    forbidden: (value) => /(?:^|\/)(?:api|persistence|chatgpt|conversations)(?:\/|$)/.test(value),
    message: 'browser/ must stay independent from api/persistence/chatgpt/conversations',
  },
  {
    dir: 'chatgpt',
    forbidden: (value) =>
      /(?:^|\/)(?:api|persistence)(?:\/|$)/.test(value) ||
      /browser\/(?:browser-manager|page-pool)/.test(value) ||
      /conversations\/(?:conversation-engine|page-registry)/.test(value),
    message:
      'chatgpt/ must not depend on api/persistence, BrowserManager/PagePool, Conversation Engine, or Page Registry',
  },
];

export function architectureImportViolation(directory, imported) {
  const rule = rules.find((candidate) => candidate.dir === directory);
  if (!rule || !rule.forbidden(imported)) return undefined;
  return rule.message;
}

export { rules as architectureImportRules };
