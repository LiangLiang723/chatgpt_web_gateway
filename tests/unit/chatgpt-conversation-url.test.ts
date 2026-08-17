import { describe, expect, it } from 'vitest';

import { parseSafeChatGptConversationUrl } from '../../src/chatgpt/conversation-url.js';

describe('parseSafeChatGptConversationUrl', () => {
  it.each([
    ['https://chatgpt.com/c/abc', '/c/abc'],
    ['https://chatgpt.com/c/abc?x=1', '/c/abc'],
    ['https://chatgpt.com/c/abc?x=1#latest', '/c/abc'],
  ])('accepts safe ChatGPT Conversation URL %s', (value, pathname) => {
    expect(parseSafeChatGptConversationUrl(value)).toEqual({
      href: value,
      pathname,
    });
  });

  it.each([
    'http://chatgpt.com/c/abc',
    'https://example.com/c/abc',
    'https://chatgpt.com/',
    'https://chatgpt.com/c/WEB:temporary-bootstrap',
    'not-a-url',
  ])('rejects unsafe or non-Conversation URL %s', (value) => {
    expect(parseSafeChatGptConversationUrl(value)).toBeUndefined();
  });

  it('provides query/hash-independent canonical pathname identity', () => {
    const stored = parseSafeChatGptConversationUrl(
      'https://chatgpt.com/c/abc?temporary-chat=false#stored',
    );
    const current = parseSafeChatGptConversationUrl('https://chatgpt.com/c/abc?model=auto#current');

    expect(stored?.pathname).toBe('/c/abc');
    expect(current?.pathname).toBe(stored?.pathname);
  });
});
