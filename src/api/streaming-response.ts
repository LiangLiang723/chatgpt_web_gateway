import type { FastifyReply } from 'fastify';

import type { NormalizedStreamingExecutionHandler, TextStreamSink } from './execution.js';
import {
  GatewayError,
  gatewayErrorFromExecution,
  toOpenAIErrorBody,
  type OpenAIErrorBody,
} from './errors.js';
import type { NormalizedRequest } from './normalized.js';
import { createSseWriter } from './sse.js';

export interface EncodedStreamFrame {
  event?: string;
  data: string;
}

export interface RunStreamingResponseOptions {
  reply: FastifyReply;
  request: NormalizedRequest;
  stream: NormalizedStreamingExecutionHandler;
  encodeEvent: (event: Parameters<TextStreamSink>[0]) => EncodedStreamFrame[];
  encodeError: (error: OpenAIErrorBody['error']) => EncodedStreamFrame[];
}

async function writeFrames(
  writer: ReturnType<typeof createSseWriter>,
  frames: EncodedStreamFrame[],
): Promise<void> {
  for (const frame of frames) {
    if (frame.event === undefined) await writer.writeData(frame.data);
    else await writer.writeEvent(frame.event, frame.data);
  }
}

function safeStreamError(error: unknown): GatewayError {
  return (
    gatewayErrorFromExecution(error) ??
    new GatewayError({
      message: 'Internal server error',
      statusCode: 500,
      type: 'server_error',
      code: 'internal_error',
    })
  );
}

export async function runStreamingResponse(options: RunStreamingResponseOptions): Promise<void> {
  const controller = new AbortController();
  let started = false;
  let writer: ReturnType<typeof createSseWriter> | undefined;

  const abortForClosedTransport = () => {
    if (!options.reply.raw.writableFinished) controller.abort();
  };
  options.reply.raw.once('close', abortForClosedTransport);
  options.reply.raw.once('error', abortForClosedTransport);

  try {
    await options.stream(options.request, {
      signal: controller.signal,
      sink: async (event) => {
        if (!started) {
          if (event.type !== 'started') {
            throw new Error('Streaming backend emitted data before the started event');
          }
          started = true;
          options.reply.hijack();
          options.reply.raw.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
          });
          writer = createSseWriter(options.reply.raw);
        }
        await writeFrames(writer!, options.encodeEvent(event));
      },
    });

    if (!started) {
      throw new Error('Streaming backend completed without emitting a started event');
    }
    writer?.end();
  } catch (error) {
    if (!started) throw error;
    if (controller.signal.aborted || writer?.closed) {
      writer?.end();
      return;
    }

    const gatewayError = safeStreamError(error);
    await writeFrames(writer!, options.encodeError(toOpenAIErrorBody(gatewayError).error));
    writer?.end();
  } finally {
    options.reply.raw.off('close', abortForClosedTransport);
    options.reply.raw.off('error', abortForClosedTransport);
  }
}
