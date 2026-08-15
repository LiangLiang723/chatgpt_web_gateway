import { describe, expect, it } from 'vitest';

import type { NormalizedInstruction, NormalizedMessage } from '../../src/api/normalized.js';
import { planContextSync } from '../../src/context/sync.js';

const instructions: NormalizedInstruction[] = [
  { role: 'system', content: 'system rule' },
  { role: 'developer', content: 'developer rule' },
];

const user = (text: string): NormalizedMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

const assistant = (text: string): NormalizedMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
});

const persisted = (messages: NormalizedMessage[], conversationUrl = 'https://chatgpt.com/c/abc') => ({
  instructions: structuredClone(instructions),
  messages: structuredClone(messages),
  conversationUrl,
});

describe('planContextSync', () => {
  it('selects FRESH when no synchronized Conversation exists', () => {
    expect(
      planContextSync({
        instructions,
        messages: [user('first')],
        hasWarmPage: false,
      }),
    ).toEqual({ mode: 'FRESH', appendMessages: [] });
  });

  it('selects APPEND for one new user turn on an exact warm synchronized prefix', () => {
    const stored = [user('one'), assistant('reply one')];
    const next = user('two');

    expect(
      planContextSync({
        instructions: structuredClone(instructions),
        messages: [...structuredClone(stored), next],
        persisted: persisted(stored),
        hasWarmPage: true,
      }),
    ).toEqual({ mode: 'APPEND', appendMessages: [next] });
  });

  it('selects RESTORE for one new user turn when only the persisted URL can recover the page', () => {
    const stored = [user('one'), assistant('reply one')];
    const next = user('two');

    expect(
      planContextSync({
        instructions,
        messages: [...stored, next],
        persisted: persisted(stored),
        hasWarmPage: false,
      }),
    ).toEqual({ mode: 'RESTORE', appendMessages: [next] });
  });

  it('selects REBUILD when a safe prefix exists but the persisted URL is absent', () => {
    const stored = [user('one'), assistant('reply one')];
    const withoutUrl = { ...persisted(stored), conversationUrl: undefined };

    expect(
      planContextSync({
        instructions,
        messages: [...stored, user('two')],
        persisted: withoutUrl,
        hasWarmPage: false,
      }),
    ).toEqual({ mode: 'REBUILD', appendMessages: [] });

    expect(
      planContextSync({
        instructions,
        messages: [...stored, user('two')],
        persisted: withoutUrl,
        hasWarmPage: true,
      }),
    ).toEqual({ mode: 'REBUILD', appendMessages: [] });
  });

  it('selects REBUILD when system or developer instructions changed', () => {
    const stored = [user('one'), assistant('reply one')];

    expect(
      planContextSync({
        instructions: [{ role: 'system', content: 'changed rule' }],
        messages: [...stored, user('two')],
        persisted: persisted(stored),
        hasWarmPage: true,
      }).mode,
    ).toBe('REBUILD');
  });

  it('selects REBUILD when a previously synchronized message was edited', () => {
    const stored = [user('one'), assistant('reply one')];

    expect(
      planContextSync({
        instructions,
        messages: [user('edited one'), assistant('reply one'), user('two')],
        persisted: persisted(stored),
        hasWarmPage: true,
      }).mode,
    ).toBe('REBUILD');
  });

  it('selects REBUILD for rolled-back or forked caller history', () => {
    const stored = [user('one'), assistant('reply one'), user('two'), assistant('reply two')];

    expect(
      planContextSync({
        instructions,
        messages: [user('one'), assistant('reply one'), user('forked three')],
        persisted: persisted(stored),
        hasWarmPage: true,
      }).mode,
    ).toBe('REBUILD');
  });

  it('selects REBUILD when more than one unsynchronized message follows the exact prefix', () => {
    const stored = [user('one'), assistant('reply one')];

    expect(
      planContextSync({
        instructions,
        messages: [
          ...stored,
          user('two'),
          assistant('caller supplied reply two'),
          user('three'),
        ],
        persisted: persisted(stored),
        hasWarmPage: true,
      }).mode,
    ).toBe('REBUILD');
  });

  it('compares normalized semantic values rather than object identity', () => {
    const stored = [
      {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'one' }],
      },
      {
        role: 'assistant' as const,
        content: [{ type: 'text' as const, text: 'reply one' }],
      },
    ];

    expect(
      planContextSync({
        instructions: structuredClone(instructions),
        messages: [...structuredClone(stored), user('two')],
        persisted: persisted(stored),
        hasWarmPage: true,
      }).mode,
    ).toBe('APPEND');
  });
});
