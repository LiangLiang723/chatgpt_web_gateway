import { TextStreamAbortedError } from '../stream/errors.js';

export interface SseWritable {
  writableFinished: boolean;
  write(chunk: string): boolean;
  end(): void;
  once(event: 'drain' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
  off(event: 'drain' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
}

export interface SseWriter {
  readonly closed: boolean;
  writeData(data: string): Promise<void>;
  writeEvent(event: string, data: string): Promise<void>;
  end(): void;
}

export function formatSseData(data: string): string {
  return `data: ${data}\n\n`;
}

export function formatSseEvent(event: string, data: string): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

async function waitForDrain(response: SseWritable): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain);
      response.off('close', onClose);
      response.off('error', onError);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new TextStreamAbortedError());
    };
    const onError = () => {
      cleanup();
      reject(new TextStreamAbortedError());
    };

    response.once('drain', onDrain);
    response.once('close', onClose);
    response.once('error', onError);
  });
}

export function createSseWriter(response: SseWritable): SseWriter {
  let closed = false;
  response.once('close', () => {
    closed = true;
  });
  response.once('error', () => {
    closed = true;
  });

  const write = async (frame: string): Promise<void> => {
    if (closed || response.writableFinished) throw new TextStreamAbortedError();
    if (!response.write(frame)) await waitForDrain(response);
  };

  return {
    get closed() {
      return closed;
    },
    writeData: async (data) => write(formatSseData(data)),
    writeEvent: async (event, data) => write(formatSseEvent(event, data)),
    end() {
      if (closed || response.writableFinished) {
        closed = true;
        return;
      }
      closed = true;
      response.end();
    },
  };
}
