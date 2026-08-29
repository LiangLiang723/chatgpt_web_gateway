export type Phase6Scenario = 'all' | 'images' | 'documents' | 'xlsx' | 'memory' | 'streaming';

export function parsePhase6Scenario(value: string | undefined): Phase6Scenario {
  if (value === undefined || value === '') return 'all';
  if (
    value === 'images' ||
    value === 'documents' ||
    value === 'xlsx' ||
    value === 'memory' ||
    value === 'streaming'
  ) {
    return value;
  }
  throw new Error(
    'E2E_CHATGPT_PHASE6_SCENARIO must be one of: images, documents, xlsx, memory, streaming',
  );
}

export interface Phase6ConversationKeys {
  images: string;
  documentsPrimary: string;
  documentsSecondary: string;
  memory: string;
}

export const PHASE6_NEW_ATTACHMENT_TURN_BUDGET = {
  images: 2,
  documentsPrimary: 2,
  documentsSecondary: 2,
  memory: 1,
} as const;

export function createPhase6ConversationKeys(runId: string): Phase6ConversationKeys {
  return {
    images: `phase6-images-${runId}`,
    documentsPrimary: `phase6-documents-a-${runId}`,
    documentsSecondary: `phase6-documents-b-${runId}`,
    memory: `phase6-memory-${runId}`,
  };
}
