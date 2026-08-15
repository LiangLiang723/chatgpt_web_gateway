export interface ConversationQueue {
  readonly pendingKeyCount: number;
  run<T>(conversationKey: string, task: () => Promise<T>): Promise<T>;
}

export function createConversationQueue(): ConversationQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    get pendingKeyCount() {
      return tails.size;
    },

    async run<T>(conversationKey: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(conversationKey) ?? Promise.resolve();
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => completion);
      tails.set(conversationKey, tail);

      await previous;
      try {
        return await task();
      } finally {
        release();
        if (tails.get(conversationKey) === tail) tails.delete(conversationKey);
      }
    },
  };
}
