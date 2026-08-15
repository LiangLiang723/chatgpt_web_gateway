import { describe, expect, it } from 'vitest';

import { createConversationQueue } from '../../src/conversations/conversation-queue.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ConversationQueue', () => {
  it('serializes tasks for the same key in arrival order', async () => {
    const queue = createConversationQueue();
    const firstGate = deferred();
    const events: string[] = [];

    const first = queue.run('alpha', async () => {
      events.push('first:start');
      await firstGate.promise;
      events.push('first:end');
      return 1;
    });
    const second = queue.run('alpha', async () => {
      events.push('second:start');
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows different keys to execute concurrently', async () => {
    const queue = createConversationQueue();
    const alphaGate = deferred();
    const betaGate = deferred();
    const started = new Set<string>();

    const alpha = queue.run('alpha', async () => {
      started.add('alpha');
      await alphaGate.promise;
    });
    const beta = queue.run('beta', async () => {
      started.add('beta');
      await betaGate.promise;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(new Set(['alpha', 'beta']));

    alphaGate.resolve();
    betaGate.resolve();
    await Promise.all([alpha, beta]);
  });

  it('continues a key after a rejected task', async () => {
    const queue = createConversationQueue();
    const events: string[] = [];

    const failed = queue.run('alpha', async () => {
      events.push('failed');
      throw new Error('boom');
    });
    const recovered = queue.run('alpha', async () => {
      events.push('recovered');
      return 'ok';
    });

    await expect(failed).rejects.toThrow('boom');
    await expect(recovered).resolves.toBe('ok');
    expect(events).toEqual(['failed', 'recovered']);
  });

  it('lets already queued work drain after close while rejecting new work', async () => {
    const queue = createConversationQueue();
    const gate = deferred();
    const events: string[] = [];

    const first = queue.run('alpha', async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = queue.run('alpha', async () => {
      events.push('second:start');
    });
    await Promise.resolve();

    queue.close();
    await expect(queue.run('beta', async () => undefined)).rejects.toThrow(/queue is closed/i);
    gate.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('removes per-key bookkeeping after the last waiter completes', async () => {
    const queue = createConversationQueue();
    const gate = deferred();

    const first = queue.run('alpha', async () => gate.promise);
    const second = queue.run('alpha', async () => undefined);

    expect(queue.pendingKeyCount).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
    expect(queue.pendingKeyCount).toBe(0);
  });
});
