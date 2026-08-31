const NAMESPACE_SEPARATOR = '::';
const RESPONSES_CUSTOM_PREFIX = '__responses_custom__';

export function encodeNamespacedToolName(namespace: string, name: string): string {
  return `${namespace}${NAMESPACE_SEPARATOR}${name}`;
}

export function encodeResponsesCustomToolName(name: string, namespace?: string): string {
  return namespace === undefined
    ? `${RESPONSES_CUSTOM_PREFIX}${NAMESPACE_SEPARATOR}${name}`
    : `${RESPONSES_CUSTOM_PREFIX}${NAMESPACE_SEPARATOR}${namespace}${NAMESPACE_SEPARATOR}${name}`;
}

export function decodeNamespacedToolName(value: string): { name: string; namespace?: string } {
  const separatorIndex = value.indexOf(NAMESPACE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex >= value.length - NAMESPACE_SEPARATOR.length) {
    return { name: value };
  }

  return {
    namespace: value.slice(0, separatorIndex),
    name: value.slice(separatorIndex + NAMESPACE_SEPARATOR.length),
  };
}

export function decodeResponsesToolName(value: string): {
  kind: 'function' | 'custom';
  name: string;
  namespace?: string;
} {
  const customPrefix = `${RESPONSES_CUSTOM_PREFIX}${NAMESPACE_SEPARATOR}`;
  if (value.startsWith(customPrefix)) {
    const remainder = value.slice(customPrefix.length);
    const separatorIndex = remainder.indexOf(NAMESPACE_SEPARATOR);
    if (separatorIndex > 0 && separatorIndex < remainder.length - NAMESPACE_SEPARATOR.length) {
      return {
        kind: 'custom',
        namespace: remainder.slice(0, separatorIndex),
        name: remainder.slice(separatorIndex + NAMESPACE_SEPARATOR.length),
      };
    }
    return { kind: 'custom', name: remainder };
  }

  return { kind: 'function', ...decodeNamespacedToolName(value) };
}

export function decodeCustomToolInput(argumentsValue: string): string {
  try {
    const parsed = JSON.parse(argumentsValue) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'input' in parsed &&
      typeof (parsed as { input?: unknown }).input === 'string'
    ) {
      return (parsed as { input: string }).input;
    }
  } catch {
    // The fallback below preserves the raw arguments for malformed legacy calls.
  }
  return argumentsValue;
}
