export interface CompletedTextResult {
  type: 'text';
  text: string;
  conversationUrl: string;
  completedAt: number;
}

export type TextStreamEvent =
  | { type: 'started'; startedAt: number }
  | { type: 'text.delta'; delta: string }
  | { type: 'completed'; result: CompletedTextResult };
