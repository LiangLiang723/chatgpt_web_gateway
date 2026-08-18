import { describe, expect, it } from 'vitest';

import type { NormalizedRequest } from '../../src/api/normalized.js';
import {
  fingerprintCanonicalMessage,
  selectUploadAttachmentReferences,
  type ResolvedAttachmentSemantic,
} from '../../src/context/multimodal.js';
import { planContextSync } from '../../src/context/planner.js';
import type {
  CanonicalConversationRequest,
  CanonicalMessage,
  CanonicalStoredConversation,
} from '../../src/context/types.js';
import {
  toCanonicalConversationRequest,
  toCanonicalStreamingConversationRequest,
} from '../../src/conversations/request-context.js';

function baseRequest(overrides: Partial<NormalizedRequest> = {}): NormalizedRequest {
  return {
    requestId: 'req-1',
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    toolChoice: { mode: 'auto' },
    attachments: [],
    output: { mode: 'text', stream: false },
    diagnostics: { ignoredParameters: [] },
    ...overrides,
  };
}

function semantic(overrides: Partial<ResolvedAttachmentSemantic> = {}): ResolvedAttachmentSemantic {
  return {
    kind: 'image',
    sha256: 'a'.repeat(64),
    filename: 'image.png',
    mimeType: 'image/png',
    ...overrides,
  };
}

function attachmentRequest(
  input: {
    attachmentId?: string;
    semantic?: ResolvedAttachmentSemantic;
    stream?: boolean;
    content?: NormalizedRequest['messages'][number]['content'];
  } = {},
): {
  request: NormalizedRequest;
  resolved: ReadonlyMap<string, ResolvedAttachmentSemantic>;
} {
  const attachmentId = input.attachmentId ?? 'attachment-1';
  const value = input.semantic ?? semantic();
  return {
    request: baseRequest({
      messages: [
        {
          role: 'user',
          content: input.content ?? [
            { type: 'text', text: 'look' },
            { type: 'attachment', attachmentId },
          ],
        },
      ],
      attachments: [
        {
          id: attachmentId,
          kind: value.kind,
          source: { type: 'file_id', fileId: 'file-public' },
        },
      ],
      output: { mode: 'text', stream: input.stream ?? false },
    }),
    resolved: new Map([[attachmentId, value]]),
  };
}

function multimodalMessage(
  reference: string,
  overrides: Partial<ResolvedAttachmentSemantic> = {},
): CanonicalMessage {
  const value = semantic(overrides);
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      {
        type: 'attachment',
        reference,
        kind: value.kind,
        sha256: value.sha256,
        filename: value.filename,
        ...(value.mimeType === undefined ? {} : { mimeType: value.mimeType }),
      },
    ],
  };
}

describe('canonical multimodal request', () => {
  it('preserves ordered text/attachment content while keeping pure-text legacy shape unchanged', () => {
    const pureText = toCanonicalConversationRequest(baseRequest());
    expect(pureText.messages).toEqual([{ role: 'user', text: 'hello' }]);

    const { request, resolved } = attachmentRequest({
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'attachment', attachmentId: 'attachment-1' },
        { type: 'text', text: 'c' },
      ],
    });
    expect(toCanonicalConversationRequest(request, resolved).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a\nb' },
          {
            type: 'attachment',
            reference: 'attachment-1',
            kind: 'image',
            sha256: 'a'.repeat(64),
            filename: 'image.png',
            mimeType: 'image/png',
          },
          { type: 'text', text: 'c' },
        ],
      },
    ]);
  });

  it('treats source/request identity as non-semantic but preserves kind/bytes/filename/MIME/order', () => {
    const first = multimodalMessage('attachment-from-url');
    const same = multimodalMessage('attachment-from-file-id');
    expect(fingerprintCanonicalMessage(first)).toBe(fingerprintCanonicalMessage(same));

    for (const different of [
      multimodalMessage('other', { kind: 'file' }),
      multimodalMessage('other', { sha256: 'b'.repeat(64) }),
      multimodalMessage('other', { filename: 'other.png' }),
      multimodalMessage('other', { mimeType: 'image/jpeg' }),
      {
        role: 'user' as const,
        content: [
          (first as Extract<CanonicalMessage, { content: unknown }>).content[1]!,
          { type: 'text' as const, text: 'look' },
        ],
      },
    ]) {
      expect(fingerprintCanonicalMessage(first)).not.toBe(fingerprintCanonicalMessage(different));
    }
  });

  it('accepts an attachment-only final user and rejects empty text with no attachment', () => {
    const { request, resolved } = attachmentRequest({
      content: [{ type: 'attachment', attachmentId: 'attachment-1' }],
    });
    expect(toCanonicalConversationRequest(request, resolved).messages).toHaveLength(1);

    expect(() =>
      toCanonicalConversationRequest(
        baseRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: '   ' }] }] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid_conversation_request' }));
  });

  it('requires every attachment content reference to have a resolved semantic File', () => {
    const { request } = attachmentRequest();
    expect(() => toCanonicalConversationRequest(request, new Map())).toThrowError(
      expect.objectContaining({ code: 'invalid_conversation_request' }),
    );
  });

  it('supports the same multimodal canonicalization for streaming requests', () => {
    const { request, resolved } = attachmentRequest({ stream: true });
    expect(toCanonicalStreamingConversationRequest(request, resolved).messages).toEqual([
      multimodalMessage('attachment-1'),
    ]);
  });
});

describe('multimodal planner and upload selection', () => {
  const u1 = multimodalMessage('a1');
  const a1: CanonicalMessage = { role: 'assistant', text: 'answer-1' };
  const u2 = multimodalMessage('a2', {
    kind: 'file',
    sha256: 'b'.repeat(64),
    filename: 'notes.pdf',
    mimeType: 'application/pdf',
  });

  function request(messages: CanonicalMessage[]): CanonicalConversationRequest {
    return {
      instructions: { system: [], developer: [] },
      messages,
      mode: messages.length === 1 ? 'incremental' : 'full',
    };
  }

  function stored(messages: CanonicalMessage[] = [u1, a1]): CanonicalStoredConversation {
    return {
      instructions: { system: [], developer: [] },
      messages,
      conversationUrl: 'https://chatgpt.com/c/thread-1',
      sync: { status: 'clean', syncedMessageCount: messages.length },
    };
  }

  it('selects all effective attachments for FRESH and only current user attachments for APPEND/RESTORE', () => {
    const fresh = planContextSync({ request: request([u1, a1, u2]), hasAffinityPage: false });
    expect(fresh.mode).toBe('FRESH');
    expect(selectUploadAttachmentReferences(fresh)).toEqual(['a1', 'a2']);

    const append = planContextSync({
      stored: stored(),
      request: request([u1, a1, u2]),
      hasAffinityPage: true,
    });
    expect(append.mode).toBe('APPEND');
    expect(selectUploadAttachmentReferences(append)).toEqual(['a2']);

    const restore = planContextSync({
      stored: stored(),
      request: request([u1, a1, u2]),
      hasAffinityPage: false,
    });
    expect(restore.mode).toBe('RESTORE');
    expect(selectUploadAttachmentReferences(restore)).toEqual(['a2']);
  });

  it('detects attachment semantic divergence and selects the full REBUILD attachment set', () => {
    const changedU1 = multimodalMessage('request-a1', { sha256: 'c'.repeat(64) });
    const plan = planContextSync({
      stored: stored(),
      request: request([changedU1, a1, u2]),
      hasAffinityPage: true,
    });
    expect(plan.mode).toBe('REBUILD');
    expect(plan).toMatchObject({ reason: 'history_diverged' });
    expect(selectUploadAttachmentReferences(plan)).toEqual(['request-a1', 'a2']);
  });

  it('uses stored confirmed attachment references for incremental REBUILD', () => {
    const plan = planContextSync({
      stored: {
        ...stored(),
        sync: { status: 'in_flight', syncedMessageCount: 2 },
      },
      request: request([u2]),
      hasAffinityPage: true,
    });
    expect(plan.mode).toBe('REBUILD');
    expect(selectUploadAttachmentReferences(plan)).toEqual(['a1', 'a2']);
  });
});
