import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  RemoteImageFetcher,
  isPublicIpAddress,
  parseRemoteImageUrl,
  type DnsAddress,
  type RemoteTransport,
  type RemoteTransportResponse,
} from '../../src/attachments/network-policy.js';

function response(
  statusCode: number,
  options: { location?: string; contentType?: string; body?: string | Buffer } = {},
): RemoteTransportResponse {
  const body = Readable.from([
    typeof options.body === 'string'
      ? Buffer.from(options.body)
      : (options.body ?? Buffer.alloc(0)),
  ]);
  return {
    statusCode,
    headers: {
      ...(options.location === undefined ? {} : { location: options.location }),
      ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
    },
    body,
    destroy: () => body.destroy(),
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('remote image URL syntax policy', () => {
  it.each(['https://example.com/a.png', 'http://example.com/a.png'])('accepts %s', (value) => {
    expect(parseRemoteImageUrl(value).href).toBe(value);
  });

  it.each([
    'file:///etc/passwd',
    'ftp://example.com/a.png',
    'data:image/png;base64,AAAA',
    'blob:https://example.com/id',
    'https://user:pass@example.com/a.png',
    'https://user@example.com/a.png',
  ])('rejects %s', (value) => {
    expect(() => parseRemoteImageUrl(value)).toThrowError(
      expect.objectContaining({ code: 'invalid_attachment' }),
    );
  });
});

describe('public IP policy', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'allows public address %s',
    (address) => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicIpAddress(address)).toBe(false);
  });
});

describe('RemoteImageFetcher SSRF and redirect policy', () => {
  it('checks every DNS answer and refuses to open when any answer is non-public', async () => {
    const resolve = vi.fn(async (): Promise<DnsAddress[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const open = vi.fn<RemoteTransport>(async () => response(200, { body: 'nope' }));
    const fetcher = new RemoteImageFetcher({ resolve, open });

    await expect(fetcher.fetch('https://example.com/a.png')).rejects.toMatchObject({
      code: 'invalid_attachment',
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('pins the connection to a validated DNS answer', async () => {
    const resolve = vi.fn(async (): Promise<DnsAddress[]> => [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ]);
    const open = vi.fn<RemoteTransport>(async (_url, address) => {
      expect(address).toEqual({ address: '93.184.216.34', family: 4 });
      return response(200, { contentType: 'image/png', body: 'abc' });
    });
    const fetcher = new RemoteImageFetcher({ resolve, open });

    const result = await fetcher.fetch('https://example.com/a.png?token=secret');
    expect(result.contentType).toBe('image/png');
    expect(await collect(result.source)).toEqual(Buffer.from('abc'));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('re-runs scheme and DNS policy for every redirect', async () => {
    const resolve = vi.fn(async (hostname: string): Promise<DnsAddress[]> =>
      hostname === 'example.com'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '10.0.0.1', family: 4 }],
    );
    const open = vi.fn<RemoteTransport>(async () =>
      response(302, { location: 'http://internal.test/secret.png' }),
    );
    const fetcher = new RemoteImageFetcher({ resolve, open });

    await expect(fetcher.fetch('https://example.com/start')).rejects.toMatchObject({
      code: 'invalid_attachment',
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('limits redirects to five hops', async () => {
    const resolve = vi.fn(async (): Promise<DnsAddress[]> => [
      { address: '93.184.216.34', family: 4 },
    ]);
    let hop = 0;
    const open = vi.fn<RemoteTransport>(async () => {
      hop += 1;
      return response(302, { location: `https://example.com/hop-${hop}` });
    });
    const fetcher = new RemoteImageFetcher({ resolve, open });

    await expect(fetcher.fetch('https://example.com/start')).rejects.toMatchObject({
      code: 'attachment_fetch_failed',
    });
    expect(open).toHaveBeenCalledTimes(6);
  });

  it('rejects a streamed body above the attachment limit and destroys the response', async () => {
    const resolve = vi.fn(async (): Promise<DnsAddress[]> => [
      { address: '93.184.216.34', family: 4 },
    ]);
    const body = Readable.from([Buffer.alloc(32 * 1024 * 1024, 0x61), Buffer.from('x')]);
    const destroy = vi.fn(() => body.destroy());
    const open = vi.fn<RemoteTransport>(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body,
      destroy,
    }));
    const fetcher = new RemoteImageFetcher({ resolve, open });
    const result = await fetcher.fetch('https://example.com/large.png');

    await expect(collect(result.source)).rejects.toMatchObject({ code: 'attachment_too_large' });
    expect(destroy).toHaveBeenCalled();
  });

  it('sanitizes transport errors so signed URL query values are not exposed', async () => {
    const resolve = vi.fn(async (): Promise<DnsAddress[]> => [
      { address: '93.184.216.34', family: 4 },
    ]);
    const open = vi.fn<RemoteTransport>(async () => {
      throw new Error('connection failed for https://example.com/a?token=super-secret');
    });
    const fetcher = new RemoteImageFetcher({ resolve, open });

    let caught: unknown;
    try {
      await fetcher.fetch('https://example.com/a?token=super-secret');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'attachment_fetch_failed' });
    expect(String((caught as Error).message)).not.toContain('super-secret');
  });
});
