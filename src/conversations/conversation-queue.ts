export interface ConversationQueue {
  readonly pendingKeyCount: number;
  run<T>(conversationKey: string, work: () => Promise<T>): Promise<T>;
  close(): void;
}

export function createConversationQueue(): ConversationQueue {
  const tails = new Map<string, Promise<void>>();
  let closed = false;

  return {
    get pendingKeyCount() {
      return tails.size;
    },

    run<T>(conversationKey: string, work: () => Promise<T>): Promise<T> {
      if (closed) return Promise.reject(new Error('Conversation queue is closed'));

      const previous = tails.get(conversationKey) ?? Promise.resolve();
      const start = previous.catch(() => undefined);
      const current = start.then(work);
      const tail = current.then(
        () => undefined,
        () => undefined,
      );
      tails.set(conversationKey, tail);
      void tail.finally(() => {
        if (tails.get(conversationKey) === tail) tails.delete(conversationKey);
      });
      return current;
    },

    close() {
      closed = true;
    },
  };
}
