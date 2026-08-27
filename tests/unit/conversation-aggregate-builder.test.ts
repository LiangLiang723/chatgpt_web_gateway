import { describe, expect, it } from 'vitest';

import { buildFinalConversationAggregate } from '../../src/conversations/aggregate-builder.js';
import type { CanonicalMessage, CanonicalTextMessage } from '../../src/context/types.js';
import type {
  ConversationAggregate,
  ConversationRecord,
  MessageRecord,
} from '../../src/persistence/types.js';

const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];

function message(
  id: string,
  sequence: number,
  role: 'user' | 'assistant',
  text: string,
): MessageRecord {
  return {
    id,
    conversationId,
    sequence,
    role,
    content: [{ type: 'text', text }],
    createdAt: 100 + sequence,
    updatedAt: 200 + sequence,
  };
}

function conversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: conversationId,
    conversationKey: 'thread-1',
    chatgptConversationUrl: 'https://chatgpt.com/c/old',
    instructions: [{ role: 'system', content: 'old system' }],
    tools: [],
    toolChoice: { mode: 'auto' },
    sync: { status: 'in_flight', syncedMessageCount: 4, startedAt: 900 },
    createdAt: 50,
    updatedAt: 900,
    lastUsedAt: 900,
    ...overrides,
  };
}

function stored(): ConversationAggregate {
  return {
    conversation: conversation(),
    messages: [
      message(ids[0]!, 0, 'user', 'u1'),
      message(ids[1]!, 1, 'assistant', 'a1'),
      message(ids[2]!, 2, 'user', 'u2'),
      message(ids[3]!, 3, 'assistant', 'a2'),
    ],
    toolCalls: [],
    attachments: [],
    generatedImages: [],
  };
}

function canonical(...entries: Array<['user' | 'assistant', string]>): CanonicalTextMessage[] {
  return entries.map(([role, text]) => ({ role, text }));
}

function texts(aggregate: ConversationAggregate): Array<{ role: string; text: string }> {
  return aggregate.messages.map((record) => ({
    role: record.role,
    text: record.content.map((part) => (part.type === 'text' ? part.text : '')).join('\n'),
  }));
}

function expectNewUuid(value: string): void {
  expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(ids).not.toContain(value);
}

describe('buildFinalConversationAggregate', () => {
  it('reuses every stored Message id for instructions-only REBUILD and appends current/assistant', () => {
    const result = buildFinalConversationAggregate({
      stored: stored(),
      conversation: conversation({
        instructions: [{ role: 'system', content: 'new system' }],
      }),
      authoritativeMessages: canonical(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'u2'],
        ['assistant', 'a2'],
        ['user', 'u3'],
      ),
      assistantText: 'a3',
      conversationUrl: 'https://chatgpt.com/c/new',
      completedAt: 1000,
    });

    expect(result.messages.slice(0, 4).map((record) => record.id)).toEqual(ids);
    expectNewUuid(result.messages[4]!.id);
    expectNewUuid(result.messages[5]!.id);
    expect(texts(result)).toEqual([
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'u2' },
      { role: 'assistant', text: 'a2' },
      { role: 'user', text: 'u3' },
      { role: 'assistant', text: 'a3' },
    ]);
    expect(result.conversation).toMatchObject({
      id: conversationId,
      chatgptConversationUrl: 'https://chatgpt.com/c/new',
      sync: { status: 'clean', syncedMessageCount: 6 },
      updatedAt: 1000,
      lastUsedAt: 1000,
    });
    expect(result.conversation.sync.startedAt).toBeUndefined();
  });

  it('reuses only the canonical longest common prefix after history divergence', () => {
    const result = buildFinalConversationAggregate({
      stored: stored(),
      conversation: conversation(),
      authoritativeMessages: canonical(
        ['user', 'u1'],
        ['assistant', 'edited-a1'],
        ['user', 'u2'],
        ['assistant', 'a2'],
        ['user', 'u3'],
      ),
      assistantText: 'a3',
      conversationUrl: 'https://chatgpt.com/c/rebuilt',
      completedAt: 1000,
    });

    expect(result.messages[0]!.id).toBe(ids[0]);
    for (const record of result.messages.slice(1)) expectNewUuid(record.id);
    expect(result.messages.map((record) => record.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('APPEND reuses all stored ids and creates only current user plus new assistant ids', () => {
    const result = buildFinalConversationAggregate({
      stored: stored(),
      conversation: conversation(),
      authoritativeMessages: canonical(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'u2'],
        ['assistant', 'a2'],
        ['user', 'u3'],
      ),
      assistantText: 'a3',
      conversationUrl: 'https://chatgpt.com/c/old?model=auto',
      completedAt: 1200,
    });

    expect(result.messages.slice(0, 4).map((record) => record.id)).toEqual(ids);
    expectNewUuid(result.messages[4]!.id);
    expectNewUuid(result.messages[5]!.id);
    expect(result.messages[4]!.content).toEqual([{ type: 'text', text: 'u3' }]);
    expect(result.messages[5]!.content).toEqual([{ type: 'text', text: 'a3' }]);
  });

  it('persists assistant tool calls and linked tool results while reusing the canonical prefix', () => {
    const callId = 'call_11111111111111111111111111111111';
    const toolHistory: CanonicalMessage[] = [
      { role: 'user', text: 'weather?' },
      {
        role: 'assistant',
        text: '',
        toolCalls: [
          {
            externalCallId: callId,
            name: 'get_weather',
            arguments: '{"city":"Xiamen"}',
          },
        ],
      },
      { role: 'tool', toolCallId: callId, text: '{"condition":"sunny"}' },
    ];
    const first = buildFinalConversationAggregate({
      conversation: conversation({ sync: { status: 'in_flight', syncedMessageCount: 0 } }),
      authoritativeMessages: toolHistory.slice(0, 1),
      assistantResult: {
        type: 'tool_calls',
        toolCalls: [{ id: callId, name: 'get_weather', arguments: '{"city":"Xiamen"}' }],
      },
      conversationUrl: 'https://chatgpt.com/c/tools',
      completedAt: 1300,
    });
    expect(first.messages.map((record) => record.role)).toEqual(['user', 'assistant']);
    expect(first.messages[1]!.content).toEqual([]);
    expect(first.toolCalls).toHaveLength(1);
    expect(first.toolCalls[0]).toMatchObject({
      messageId: first.messages[1]!.id,
      externalCallId: callId,
      name: 'get_weather',
      argumentsText: '{"city":"Xiamen"}',
    });

    const second = buildFinalConversationAggregate({
      stored: first,
      storedCanonicalMessages: toolHistory.slice(0, 2),
      conversation: { ...first.conversation, sync: { status: 'in_flight', syncedMessageCount: 2 } },
      authoritativeMessages: toolHistory,
      assistantResult: { type: 'text', text: 'Sunny.' },
      conversationUrl: 'https://chatgpt.com/c/tools',
      completedAt: 1400,
    });
    expect(second.messages.slice(0, 2).map((record) => record.id)).toEqual(
      first.messages.map((record) => record.id),
    );
    expect(second.toolCalls[0]!.id).toBe(first.toolCalls[0]!.id);
    expect(second.messages[2]).toMatchObject({ role: 'tool', toolCallId: callId });
    expect(second.messages[3]).toMatchObject({ role: 'assistant' });
    expect(second.conversation.sync).toEqual({ status: 'clean', syncedMessageCount: 4 });
  });
});
