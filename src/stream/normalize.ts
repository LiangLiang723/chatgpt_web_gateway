export function normalizeAssistantText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}
