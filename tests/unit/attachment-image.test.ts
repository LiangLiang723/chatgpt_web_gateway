import { describe, expect, it } from 'vitest';

import {
  decodeBase64Strict,
  parseImageDataUrl,
  validateImageBytes,
} from '../../src/attachments/image.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
const webp = Buffer.from('524946460400000057454250', 'hex');
const gif = Buffer.from('4749463839610100', 'hex');

describe('strict Base64 decoding', () => {
  it('decodes canonical padded and unpadded quartets only when syntactically valid', () => {
    expect(decodeBase64Strict('QUJD')).toEqual(Buffer.from('ABC'));
    expect(decodeBase64Strict('QQ==')).toEqual(Buffer.from('A'));
    expect(decodeBase64Strict('QUI=')).toEqual(Buffer.from('AB'));
  });

  it.each(['', 'A', 'AAA', 'QU JD', 'QUJD\n', '!!!!', 'A===', 'AAAA=', 'AA=A'])(
    'rejects invalid Base64 %j',
    (value) => {
      expect(() => decodeBase64Strict(value)).toThrowError(
        expect.objectContaining({ code: 'invalid_attachment' }),
      );
    },
  );

  it('rejects oversized encoded data before accepting decoded bytes', () => {
    expect(() => decodeBase64Strict('QUJD', 2)).toThrowError(
      expect.objectContaining({ code: 'attachment_too_large' }),
    );
  });
});

describe('image signature validation', () => {
  it.each([
    [png, 'image/png', 'png'],
    [jpeg, 'image/jpeg', 'jpg'],
    [webp, 'image/webp', 'webp'],
    [gif, 'image/gif', 'gif'],
  ] as const)('sniffs %s as %s', (bytes, mimeType, extension) => {
    expect(validateImageBytes(bytes)).toEqual({ mimeType, extension });
    expect(validateImageBytes(bytes, mimeType)).toEqual({ mimeType, extension });
  });

  it('rejects unsupported bytes and declared MIME/signature mismatch', () => {
    expect(() => validateImageBytes(Buffer.from('not an image'))).toThrowError(
      expect.objectContaining({ code: 'invalid_attachment' }),
    );
    expect(() => validateImageBytes(png, 'image/jpeg')).toThrowError(
      expect.objectContaining({ code: 'invalid_attachment' }),
    );
    expect(() => validateImageBytes(png, 'text/plain')).toThrowError(
      expect.objectContaining({ code: 'invalid_attachment' }),
    );
  });
});

describe('image Data URL parsing', () => {
  it.each([
    [png, 'image/png', 'image.png'],
    [jpeg, 'image/jpeg', 'image.jpg'],
    [webp, 'image/webp', 'image.webp'],
    [gif, 'image/gif', 'image.gif'],
  ] as const)('parses a strict supported %s Data URL', (bytes, mimeType, filename) => {
    const parsed = parseImageDataUrl(`data:${mimeType};base64,${bytes.toString('base64')}`);
    expect(parsed).toEqual({ bytes, mimeType, filename });
  });

  it.each([
    'data:text/plain;base64,QUJD',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png,AAAA',
    'data:image/png;charset=utf-8;base64,AAAA',
    'data:image/png;base64,!!!!',
  ])('rejects unsupported or malformed Data URL %j', (value) => {
    expect(() => parseImageDataUrl(value)).toThrowError(
      expect.objectContaining({ code: 'invalid_attachment' }),
    );
  });

  it('rejects a supported declared MIME whose bytes have a different signature', () => {
    expect(() =>
      parseImageDataUrl(`data:image/jpeg;base64,${png.toString('base64')}`),
    ).toThrowError(expect.objectContaining({ code: 'invalid_attachment' }));
  });
});
