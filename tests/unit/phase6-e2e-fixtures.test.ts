import { describe, expect, it } from 'vitest';

import {
  buildDocxFixture,
  buildPdfFixture,
  buildPngTokenFixture,
  buildTextFixture,
  buildXlsxFixture,
  createImageToken,
} from '../e2e/phase6-fixtures.js';

describe('Phase 6 real E2E fixture builders', () => {
  it('builds a deterministic PNG only for high-contrast solid-color markers', () => {
    const bytes = buildPngTokenFixture('RED');
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(512);
    expect(bytes.readUInt32BE(20)).toBe(512);
    expect(bytes.byteLength).toBeGreaterThan(200);
    expect(() => buildPngTokenFixture('GREEN')).toThrow(/RED or BLUE/);
  });

  it('creates distinct solid-color image markers for consecutive image turns', () => {
    const first = createImageToken();
    const second = createImageToken(first);
    expect(first).toMatch(/^(?:RED|BLUE)$/);
    expect(second).toMatch(/^(?:RED|BLUE)$/);
    expect(second).not.toBe(first);
  });

  it('builds text and PDF fixtures containing the requested token', () => {
    const token = 'P6DOC1234';
    expect(buildTextFixture(token).toString('utf8')).toContain(token);
    const pdf = buildPdfFixture(token);
    expect(pdf.subarray(0, 8).toString('ascii')).toBe('%PDF-1.4');
    expect(pdf.toString('latin1')).toContain(token);
  });

  it('builds ZIP-based DOCX/XLSX fixtures with embedded unique tokens', () => {
    const docxToken = 'P6DOCX1234';
    const xlsxToken = 'P6XLSX1234';
    const docx = buildDocxFixture(docxToken);
    const xlsx = buildXlsxFixture(xlsxToken);
    expect(docx.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(xlsx.subarray(0, 4).toString('hex')).toBe('504b0304');
    expect(docx.toString('utf8')).toContain(docxToken);
    expect(xlsx.toString('utf8')).toContain(xlsxToken);
  });
});
