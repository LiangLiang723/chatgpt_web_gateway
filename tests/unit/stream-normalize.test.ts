import { describe, expect, it } from 'vitest';

import { normalizeAssistantText } from '../../src/stream/normalize.js';

describe('normalizeAssistantText', () => {
  it('normalizes CRLF and CR to LF without trimming visible text', () => {
    expect(normalizeAssistantText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeAssistantText('  code  \n')).toBe('  code  \n');
  });

  it('preserves markdown indentation and unicode content', () => {
    const text = '```ts\r\n  const face = "😀";\r\n```\r\n';
    expect(normalizeAssistantText(text)).toBe('```ts\n  const face = "😀";\n```\n');
  });
});
