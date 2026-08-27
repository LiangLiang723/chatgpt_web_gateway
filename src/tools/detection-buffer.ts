import { TOOL_PROTOCOL_START, ToolProtocolError } from './protocol.js';

export type ToolStreamClassification = 'pending' | 'text' | 'tool';

function longestSentinelPrefixSuffix(value: string): number {
  const maximum = Math.min(value.length, TOOL_PROTOCOL_START.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(TOOL_PROTOCOL_START.slice(0, length))) return length;
  }
  return 0;
}

export class ToolDetectionBuffer {
  private state: ToolStreamClassification;
  private buffer = '';

  constructor(private readonly enabled = true) {
    this.state = enabled ? 'pending' : 'text';
  }

  get classification(): ToolStreamClassification {
    return this.state;
  }

  push(delta: string): string[] {
    if (delta.length === 0) return [];
    if (!this.enabled) return [delta];
    if (this.state === 'tool') {
      this.buffer += delta;
      return [];
    }
    if (this.state === 'pending') {
      this.buffer += delta;
      const candidate = this.buffer.trimStart();
      if (candidate.startsWith(TOOL_PROTOCOL_START)) {
        this.state = 'tool';
        return [];
      }
      if (candidate.length === 0 || TOOL_PROTOCOL_START.startsWith(candidate)) return [];
      this.state = 'text';
    } else {
      this.buffer += delta;
    }

    if (this.buffer.includes(TOOL_PROTOCOL_START)) {
      throw new ToolProtocolError(
        'chatgpt_tool_protocol_invalid',
        'Private tool protocol marker appeared after text streaming began',
      );
    }

    const held = longestSentinelPrefixSuffix(this.buffer);
    const emit = held === 0 ? this.buffer : this.buffer.slice(0, -held);
    this.buffer = held === 0 ? '' : this.buffer.slice(-held);
    return emit.length === 0 ? [] : [emit];
  }

  finish(): string[] {
    if (!this.enabled || this.state === 'tool') return [];
    if (this.state === 'pending') {
      const candidate = this.buffer.trimStart();
      if (candidate.length === 0) {
        this.state = 'text';
      } else if (candidate.startsWith(TOOL_PROTOCOL_START)) {
        this.state = 'tool';
        return [];
      } else if (TOOL_PROTOCOL_START.startsWith(candidate)) {
        throw new ToolProtocolError(
          'chatgpt_tool_protocol_invalid',
          'Assistant output ended with an incomplete private tool protocol marker',
        );
      } else {
        this.state = 'text';
      }
    }

    if (this.buffer.includes(TOOL_PROTOCOL_START)) {
      throw new ToolProtocolError(
        'chatgpt_tool_protocol_invalid',
        'Private tool protocol marker appeared after text streaming began',
      );
    }
    const emit = this.buffer;
    this.buffer = '';
    return emit.length === 0 ? [] : [emit];
  }
}
