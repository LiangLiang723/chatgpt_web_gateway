export interface Phase6ConversationKeys {
  images: string;
  documents: string;
  memory: string;
  streaming: string;
}

export function createPhase6ConversationKeys(runId: string): Phase6ConversationKeys {
  return {
    images: `phase6-images-${runId}`,
    documents: `phase6-documents-${runId}`,
    memory: `phase6-memory-${runId}`,
    streaming: `phase6-stream-${runId}`,
  };
}
