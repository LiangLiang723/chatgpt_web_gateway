import { describe, expect, it } from 'vitest';

import { ToolDetectionBuffer } from '../../src/tools/detection-buffer.js';
import { TOOL_PROTOCOL_START } from '../../src/tools/protocol.js';

function expectCode(run: () => unknown, code: string): void {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe('ToolDetectionBuffer', () => {
  it('buffers a private marker split across many deltas and classifies it as tool', () => {
    const buffer = new ToolDetectionBuffer(true);
    for (const character of `  ${TOOL_PROTOCOL_START}`) expect(buffer.push(character)).toEqual([]);
    expect(buffer.classification).toBe('tool');
    expect(buffer.push('\n{"calls":[]}')).toEqual([]);
    expect(buffer.finish()).toEqual([]);
  });

  it('classifies ordinary text early and flushes it without losing characters', () => {
    const buffer = new ToolDetectionBuffer(true);
    expect(buffer.push('H')).toEqual(['H']);
    expect(buffer.classification).toBe('text');
    expect(buffer.push('ello')).toEqual(['ello']);
    expect(buffer.finish()).toEqual([]);
  });

  it('holds a possible sentinel suffix until it can safely become public text', () => {
    const buffer = new ToolDetectionBuffer(true);
    expect(buffer.push('normal <')).toEqual(['normal ']);
    expect(buffer.push('x')).toEqual(['<x']);
    expect(buffer.finish()).toEqual([]);
  });

  it('rejects a private marker that appears after text classification', () => {
    const buffer = new ToolDetectionBuffer(true);
    expect(buffer.push('normal ')).toEqual(['normal ']);
    expectCode(() => buffer.push(TOOL_PROTOCOL_START), 'chatgpt_tool_protocol_invalid');
  });

  it('rejects completion on an incomplete initial sentinel', () => {
    const buffer = new ToolDetectionBuffer(true);
    expect(buffer.push(TOOL_PROTOCOL_START.slice(0, 12))).toEqual([]);
    expectCode(() => buffer.finish(), 'chatgpt_tool_protocol_invalid');
  });

  it('bypasses classification when tools are disabled', () => {
    const buffer = new ToolDetectionBuffer(false);
    expect(buffer.push(TOOL_PROTOCOL_START)).toEqual([TOOL_PROTOCOL_START]);
    expect(buffer.classification).toBe('text');
  });
});
