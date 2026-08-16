import { describe, expect, it } from 'vitest';

import { createChatCompletionsStreamEncoder } from '../../src/api/encode/chat-completions-stream.js';
import { createResponsesStreamEncoder } from '../../src/api/encode/responses-stream.js';
import type { TextStreamEvent } from '../../src/stream/events.js';

const completed: TextStreamEvent = {
  type: 'completed',
  result: {
    type: 'text',
    text: 'Hello world',
    conversationUrl: 'https://chatgpt.com/c/test',
    completedAt: 123_900,
  },
};

describe('Chat Completions streaming encoder', () => {
  it('uses stable metadata, emits deltas, one stop chunk, and one DONE marker', () => {
    const encoder = createChatCompletionsStreamEncoder({
      id: 'chatcmpl_test',
      created: 123,
    });

    const frames = [
      ...encoder.encode({ type: 'started', startedAt: 123_000 }),
      ...encoder.encode({ type: 'text.delta', delta: 'Hello ' }),
      ...encoder.encode({ type: 'text.delta', delta: 'world' }),
      ...encoder.encode(completed),
    ];

    expect(frames.at(-1)).toEqual({ data: '[DONE]' });
    const jsonFrames = frames.slice(0, -1).map((frame) => JSON.parse(frame.data));
    expect(jsonFrames.every((frame) => frame.id === 'chatcmpl_test')).toBe(true);
    expect(jsonFrames.every((frame) => frame.created === 123)).toBe(true);
    expect(jsonFrames.every((frame) => frame.model === 'chatgpt-web')).toBe(true);
    expect(jsonFrames[0].choices[0]).toEqual({
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null,
    });
    expect(jsonFrames[1].choices[0].delta).toEqual({ content: 'Hello ' });
    expect(jsonFrames[2].choices[0].delta).toEqual({ content: 'world' });
    expect(jsonFrames[3].choices[0]).toEqual({
      index: 0,
      delta: {},
      finish_reason: 'stop',
    });
    expect(JSON.stringify(frames)).not.toContain('usage');
  });

  it('encodes a post-start error without a success terminator', () => {
    const encoder = createChatCompletionsStreamEncoder({ id: 'chatcmpl_test', created: 123 });
    const frames = encoder.encodeError({
      message: 'stream diverged',
      type: 'server_error',
      param: null,
      code: 'chatgpt_stream_diverged',
    });

    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!.data)).toEqual({
      error: {
        message: 'stream diverged',
        type: 'server_error',
        param: null,
        code: 'chatgpt_stream_diverged',
      },
    });
    expect(frames.some((frame) => frame.data === '[DONE]')).toBe(false);
  });
});

describe('Responses streaming encoder', () => {
  it('emits the typed text lifecycle with stable ids and monotonic sequence numbers', () => {
    const encoder = createResponsesStreamEncoder({
      responseId: 'resp_test',
      messageId: 'msg_test',
      createdAt: 123,
    });
    const frames = [
      ...encoder.encode({ type: 'started', startedAt: 123_000 }),
      ...encoder.encode({ type: 'text.delta', delta: 'Hello ' }),
      ...encoder.encode({ type: 'text.delta', delta: 'world' }),
      ...encoder.encode(completed),
    ];
    const events = frames.map((frame) => JSON.parse(frame.data));

    expect(frames.map((frame) => frame.event)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.filter((event) => event.response).every((event) => event.response.id === 'resp_test')).toBe(true);
    expect(events[4]).toMatchObject({
      item_id: 'msg_test',
      output_index: 0,
      content_index: 0,
      delta: 'Hello ',
    });
    expect(events[6].text).toBe('Hello world');
    expect(events[7].part.text).toBe('Hello world');
    expect(events[8].item.content[0].text).toBe('Hello world');
    expect(events[9].response.output[0].content[0].text).toBe('Hello world');
    expect(events[9].response.usage).toBeNull();
  });

  it('emits one typed error event and no response.completed', () => {
    const encoder = createResponsesStreamEncoder({
      responseId: 'resp_test',
      messageId: 'msg_test',
      createdAt: 123,
    });
    encoder.encode({ type: 'started', startedAt: 123_000 });
    const frames = encoder.encodeError({
      message: 'stream diverged',
      code: 'chatgpt_stream_diverged',
      param: null,
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe('error');
    expect(JSON.parse(frames[0]!.data)).toMatchObject({
      type: 'error',
      code: 'chatgpt_stream_diverged',
      message: 'stream diverged',
      param: null,
      sequence_number: 5,
    });
  });
});
