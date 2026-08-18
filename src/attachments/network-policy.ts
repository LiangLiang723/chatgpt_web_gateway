import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

import { AttachmentPipelineError } from './errors.js';
import {
  MAX_FILE_BYTES,
  MAX_REMOTE_REDIRECTS,
  REMOTE_CONNECT_TIMEOUT_MS,
  REMOTE_TOTAL_TIMEOUT_MS,
} from './policy.js';

export interface DnsAddress {
  address: string;
  family: 4 | 6;
}

export interface RemoteTransportResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type ResolveHostname = (hostname: string) => Promise<DnsAddress[]>;
export type RemoteTransport = (
  url: URL,
  address: DnsAddress,
  signal: AbortSignal,
  connectTimeoutMs: number,
) => Promise<RemoteTransportResponse>;

export interface RemoteFetchResult {
  contentType?: string;
  source: AsyncIterable<Uint8Array>;
}

export interface RemoteImageFetcherOptions {
  resolve?: ResolveHostname;
  open?: RemoteTransport;
  maxRedirects?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
}

const blockedIpv4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedIpv4.addSubnet(address, prefix, 'ipv4');
}

const globalIpv6 = new BlockList();
globalIpv6.addSubnet('2000::', 3, 'ipv6');
const blockedIpv6 = new BlockList();
blockedIpv6.addSubnet('2001:db8::', 32, 'ipv6');

export function parseRemoteImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AttachmentPipelineError('invalid_attachment', 'Remote image URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AttachmentPipelineError('invalid_attachment', 'Remote image URL scheme is invalid');
  }
  if (url.username || url.password) {
    throw new AttachmentPipelineError(
      'invalid_attachment',
      'Remote image URL credentials are not allowed',
    );
  }
  if (!url.hostname) {
    throw new AttachmentPipelineError(
      'invalid_attachment',
      'Remote image URL hostname is required',
    );
  }
  return url;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4.check(address, 'ipv4');
  if (family === 6) {
    return globalIpv6.check(address, 'ipv6') && !blockedIpv6.check(address, 'ipv6');
  }
  return false;
}

export class RemoteImageFetcher {
  private readonly resolve: ResolveHostname;
  private readonly open: RemoteTransport;
  private readonly maxRedirects: number;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(options: RemoteImageFetcherOptions = {}) {
    this.resolve = options.resolve ?? defaultResolveHostname;
    this.open = options.open ?? defaultRemoteTransport;
    this.maxRedirects = options.maxRedirects ?? MAX_REMOTE_REDIRECTS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? REMOTE_CONNECT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? REMOTE_TOTAL_TIMEOUT_MS;
  }

  async fetch(value: string, options: { signal?: AbortSignal } = {}): Promise<RemoteFetchResult> {
    const controller = new AbortController();
    const parentSignal = options.signal;
    const abortFromParent = (): void => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    const timeout = setTimeout(
      () => controller.abort(new Error('Remote attachment total timeout')),
      this.totalTimeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    };

    try {
      let current = parseRemoteImageUrl(value);
      let redirects = 0;

      while (true) {
        throwIfCallerAborted(parentSignal);
        const addresses = await this.resolve(validateHostname(current.hostname));
        if (addresses.length === 0 || addresses.some((item) => !isPublicIpAddress(item.address))) {
          throw new AttachmentPipelineError(
            'invalid_attachment',
            'Remote image host is not allowed',
          );
        }

        let response: RemoteTransportResponse;
        try {
          response = await this.open(
            current,
            addresses[0] as DnsAddress,
            controller.signal,
            this.connectTimeoutMs,
          );
        } catch (error) {
          throwIfCallerAborted(parentSignal);
          throw new AttachmentPipelineError(
            'attachment_fetch_failed',
            'Remote image fetch failed',
            { cause: error },
          );
        }

        const location = headerValue(response.headers, 'location');
        if (isRedirect(response.statusCode) && location !== undefined) {
          response.destroy();
          if (redirects >= this.maxRedirects) {
            throw new AttachmentPipelineError(
              'attachment_fetch_failed',
              'Remote image exceeded the redirect limit',
            );
          }
          redirects += 1;
          current = parseRemoteImageUrl(new URL(location, current).href);
          continue;
        }

        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          throw new AttachmentPipelineError(
            'attachment_fetch_failed',
            'Remote image server returned an unsuccessful response',
          );
        }

        const contentLength = parseContentLength(headerValue(response.headers, 'content-length'));
        if (contentLength !== undefined && contentLength > MAX_FILE_BYTES) {
          response.destroy();
          throw new AttachmentPipelineError(
            'attachment_too_large',
            'Remote attachment exceeds the Gateway size limit',
          );
        }

        const contentType = headerValue(response.headers, 'content-type')?.split(';', 1)[0]?.trim();
        return {
          ...(contentType ? { contentType: contentType.toLowerCase() } : {}),
          source: boundedResponseBody(response, controller.signal, parentSignal, cleanup),
        };
      }
    } catch (error) {
      cleanup();
      if (error instanceof AttachmentPipelineError) throw error;
      throwIfCallerAborted(parentSignal);
      throw new AttachmentPipelineError('attachment_fetch_failed', 'Remote image fetch failed', {
        cause: error,
      });
    }
  }
}

async function defaultResolveHostname(hostname: string): Promise<DnsAddress[]> {
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    return [{ address: hostname, family: literalFamily }];
  }
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return resolved
    .filter(
      (entry): entry is typeof entry & { family: 4 | 6 } =>
        entry.family === 4 || entry.family === 6,
    )
    .map((entry) => ({ address: entry.address, family: entry.family }));
}

async function defaultRemoteTransport(
  url: URL,
  address: DnsAddress,
  signal: AbortSignal,
  connectTimeoutMs: number,
): Promise<RemoteTransportResponse> {
  return new Promise((resolve, reject) => {
    const requestFactory = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const request = requestFactory(url, {
      method: 'GET',
      signal,
      headers: { accept: 'image/*' },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    });
    const connectTimer = setTimeout(
      () => request.destroy(new Error('Remote attachment connect timeout')),
      connectTimeoutMs,
    );
    const clearConnectTimer = (): void => clearTimeout(connectTimer);

    request.once('socket', (socket) => {
      if (socket.connecting) socket.once('connect', clearConnectTimer);
      else clearConnectTimer();
    });
    request.once('response', (response) => {
      settled = true;
      clearConnectTimer();
      resolve(adaptIncomingMessage(response));
    });
    request.once('error', (error) => {
      clearConnectTimer();
      if (!settled) reject(error);
    });
    request.end();
  });
}

function adaptIncomingMessage(response: IncomingMessage): RemoteTransportResponse {
  return {
    statusCode: response.statusCode ?? 0,
    headers: normalizeHeaders(response.headers),
    body: response,
    destroy: () => response.destroy(),
  };
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | string[] | undefined> {
  return { ...headers };
}

async function* boundedResponseBody(
  response: RemoteTransportResponse,
  signal: AbortSignal,
  parentSignal: AbortSignal | undefined,
  cleanup: () => void,
): AsyncIterable<Uint8Array> {
  let sizeBytes = 0;
  try {
    for await (const chunk of response.body) {
      throwIfCallerAborted(parentSignal);
      if (signal.aborted) throw signal.reason ?? new Error('Remote attachment aborted');
      const bytes = Buffer.from(chunk);
      sizeBytes += bytes.byteLength;
      if (sizeBytes > MAX_FILE_BYTES) {
        throw new AttachmentPipelineError(
          'attachment_too_large',
          'Remote attachment exceeds the Gateway size limit',
        );
      }
      yield bytes;
    }
  } catch (error) {
    if (error instanceof AttachmentPipelineError) throw error;
    throwIfCallerAborted(parentSignal);
    throw new AttachmentPipelineError('attachment_fetch_failed', 'Remote image fetch failed', {
      cause: error,
    });
  } finally {
    response.destroy();
    cleanup();
  }
}

function validateHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}
