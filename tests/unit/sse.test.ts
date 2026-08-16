import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createSseWriter, formatSseData, formatSseEvent } from '../../src/api/sse.js';

class FakeResponse extends EventEmitter {
  writableFinished = false;
  readonly writes: string[] = [];
  writeResult = true;
  end = vi.fn(() => {
    this.writableFinished = true;
    this.emit('close');
  });

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writeResult;
  }
}

describe('SSE formatting', () => {
  it('serializes data and named event frames with an empty-line delimiter', () => {
    expect(formatSseData('{"hello":"世界"}')).toBe('data: {"hello":"世界"}\n\n');
    expect(formatSseEvent('response.created', '{"type":"response.created"}')).toBe(
      'event: response.created\ndata: {"type":"response.created"}\n\n',
    );
  });
});

describe('createSseWriter', () => {
  it('writes frames immediately when the writable accepts them', async () => {
    const response = new FakeResponse();
    const writer = createSseWriter(response);

    await writer.writeData('one');
    await writer.writeEvent('event-name', 'two');

    expect(response.writes).toEqual(['data: one\n\n', 'event: event-name\ndata: two\n\n']);
  });

  it('waits for drain when write reports backpressure', async () => {
    const response = new FakeResponse();
    response.writeResult = false;
    const writer = createSseWriter(response);
    let resolved = false;

    const pending = writer.writeData('slow').then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    response.emit('drain');
    await pending;
    expect(resolved).toBe(true);
  });

  it('rejects a backpressured write if the connection closes before drain', async () => {
    const response = new FakeResponse();
    response.writeResult = false;
    const writer = createSseWriter(response);

    const pending = writer.writeData('slow');
    response.emit('close');

    await expect(pending).rejects.toMatchObject({ code: 'stream_aborted' });
  });

  it('ends idempotently and marks the writer closed', () => {
    const response = new FakeResponse();
    const writer = createSseWriter(response);

    writer.end();
    writer.end();

    expect(writer.closed).toBe(true);
    expect(response.end).toHaveBeenCalledTimes(1);
  });
});
