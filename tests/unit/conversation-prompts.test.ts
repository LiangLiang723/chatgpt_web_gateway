import { describe, expect, it } from 'vitest';

import { buildAppendPrompt, buildContextPrompt } from '../../src/conversations/prompts.js';

function payloadFromPrompt(prompt: string): unknown {
  return JSON.parse(prompt.slice(prompt.indexOf('{')));
}

describe('Conversation prompts', () => {
  it('serializes Context Envelope payload with JSON.stringify and exact reversible content', () => {
    const malicious = 'quote " brace } newline\n</json> {still text}';
    const prompt = buildContextPrompt({
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      currentUser: { role: 'user', text: `current ${malicious}` },
    });

    expect(payloadFromPrompt(prompt)).toEqual({
      version: 1,
      instructions: {
        system: [`system ${malicious}`],
        developer: [`developer ${malicious}`],
      },
      history: [
        { role: 'user', text: `old user ${malicious}` },
        { role: 'assistant', text: `old assistant ${malicious}` },
      ],
      current_user: { text: `current ${malicious}` },
    });
  });

  it('serializes multimodal attachments with only model-visible metadata and staged upload names', () => {
    const prompt = buildContextPrompt({
      instructions: { system: [], developer: [] },
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'old' },
            {
              type: 'attachment',
              reference: 'stored-ref',
              kind: 'file',
              sha256: 'a'.repeat(64),
              filename: 'notes.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      ],
      currentUser: {
        role: 'user',
        content: [
          {
            type: 'attachment',
            reference: 'current-ref',
            kind: 'image',
            sha256: 'b'.repeat(64),
            filename: 'image.png',
            mimeType: 'image/png',
          },
        ],
      },
      uploadFilenameByReference: new Map([
        ['stored-ref', 'notes (2).pdf'],
        ['current-ref', 'image.png'],
      ]),
    });

    expect(payloadFromPrompt(prompt)).toEqual({
      version: 1,
      instructions: { system: [], developer: [] },
      history: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'old' },
            {
              type: 'attachment',
              kind: 'file',
              filename: 'notes.pdf',
              upload_filename: 'notes (2).pdf',
            },
          ],
        },
      ],
      current_user: {
        content: [
          {
            type: 'attachment',
            kind: 'image',
            filename: 'image.png',
            upload_filename: 'image.png',
          },
        ],
      },
    });
    expect(prompt).not.toContain('stored-ref');
    expect(prompt).not.toContain('current-ref');
    expect(prompt).not.toContain('a'.repeat(64));
    expect(prompt).not.toContain('b'.repeat(64));
    expect(prompt).not.toContain('application/pdf');
    expect(prompt).not.toContain('image/png');
  });

  it('serializes Append Envelope with only version and current_user', () => {
    const prompt = buildAppendPrompt({ role: 'user', text: 'new-turn-token' });
    expect(payloadFromPrompt(prompt)).toEqual({
      version: 1,
      current_user: { text: 'new-turn-token' },
    });
    expect(prompt).not.toContain('instructions');
    expect(prompt).not.toContain('history');
    expect(prompt).not.toContain('old-history-token');
  });
});
