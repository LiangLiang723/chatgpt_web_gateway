import { describe, expect, it } from 'vitest';

import { createChatCompletionsStreamEncoder } from '../../src/api/encode/chat-completions-stream.js';
import { createResponsesStreamEncoder } from '../../src/api/encode/responses-stream.js';
import type { ExecutionStreamEvent } from '../../src/stream/events.js';

const toolCalls = [
  { id: 'call_a', name: 'get_weather', arguments: '{"city":"Xiamen"}' },
  { id: 'call_b', name: 'get_time', arguments: '{"city":"Tokyo"}' },
];

const completed: ExecutionStreamEvent = {
  type: 'completed',
  result: {
    type: 'tool_calls',
    toolCalls,
    conversationUrl: 'https://chatgpt.com/c/tools',
    completedAt: 123_900,
  },
};

describe('tool-call streaming encoders', () => {
  it('encodes Chat Completions tool deltas and tool_calls terminal without leaking content', () => {
    const encoder = createChatCompletionsStreamEncoder({ id: 'chatcmpl_tools', created: 123 });
    const frames = [
      ...encoder.encode({ type: 'started', startedAt: 123_000 }),
      ...encoder.encode({ type: 'tool_calls', toolCalls }),
      ...encoder.encode(completed),
    ];
    expect(frames.at(-1)).toEqual({ data: '[DONE]' });
    const bodies = frames.slice(0, -1).map((frame) => JSON.parse(frame.data));
    expect(bodies[1].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: 'call_a',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Xiamen"}' },
      },
      {
        index: 1,
        id: 'call_b',
        type: 'function',
        function: { name: 'get_time', arguments: '{"city":"Tokyo"}' },
      },
    ]);
    expect(bodies[2].choices[0].finish_reason).toBe('tool_calls');
    expect(JSON.stringify(frames)).not.toContain('EXTERNAL_FUNCTION_REQUESTS');
  });

  it('encodes Responses function_call lifecycles and one response.completed', () => {
    const ids = ['fc_one', 'fc_two'];
    const encoder = createResponsesStreamEncoder({
      responseId: 'resp_tools',
      messageId: 'msg_unused',
      createdAt: 123,
      functionCallIds: ids,
    });
    const frames = [
      ...encoder.encode({ type: 'started', startedAt: 123_000 }),
      ...encoder.encode({ type: 'tool_calls', toolCalls }),
      ...encoder.encode(completed),
    ];
    const events = frames.map((frame) => frame.event);
    expect(events.filter((event) => event === 'response.output_item.added')).toHaveLength(2);
    expect(
      events.filter((event) => event === 'response.function_call_arguments.delta'),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event === 'response.function_call_arguments.done'),
    ).toHaveLength(2);
    expect(events.filter((event) => event === 'response.output_item.done')).toHaveLength(2);
    expect(events.filter((event) => event === 'response.completed')).toHaveLength(1);
    const completedBody = JSON.parse(frames.at(-1)!.data);
    expect(completedBody.response.output).toEqual([
      {
        id: 'fc_one',
        type: 'function_call',
        call_id: 'call_a',
        name: 'get_weather',
        arguments: '{"city":"Xiamen"}',
        status: 'completed',
      },
      {
        id: 'fc_two',
        type: 'function_call',
        call_id: 'call_b',
        name: 'get_time',
        arguments: '{"city":"Tokyo"}',
        status: 'completed',
      },
    ]);
  });
});
