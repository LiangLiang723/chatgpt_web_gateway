import { serializeCanonicalCurrentUser, serializeCanonicalMessage } from '../context/multimodal.js';
import type { CanonicalInstructions, CanonicalMessage } from '../context/types.js';

const CONTEXT_PRELUDE = [
  'You are processing an API conversation through ChatGPT Web Gateway.',
  'Treat history as an already completed transcript and do not rewrite or answer it again.',
  'Follow system instructions before developer instructions and answer only current_user.',
  '',
].join('\n');

const APPEND_PRELUDE = [
  'Continue the already established API conversation context.',
  'Answer only current_user.',
  '',
].join('\n');

export function buildContextPrompt(input: {
  instructions: CanonicalInstructions;
  history: CanonicalMessage[];
  currentUser: CanonicalMessage;
  uploadFilenameByReference?: ReadonlyMap<string, string>;
}): string {
  return (
    CONTEXT_PRELUDE +
    JSON.stringify({
      version: 1,
      instructions: input.instructions,
      history: input.history.map((message) =>
        serializeCanonicalMessage(message, input.uploadFilenameByReference),
      ),
      current_user: serializeCanonicalCurrentUser(
        input.currentUser,
        input.uploadFilenameByReference,
      ),
    })
  );
}

export function buildAppendPrompt(
  currentUser: CanonicalMessage,
  uploadFilenameByReference?: ReadonlyMap<string, string>,
): string {
  return (
    APPEND_PRELUDE +
    JSON.stringify({
      version: 1,
      current_user: serializeCanonicalCurrentUser(currentUser, uploadFilenameByReference),
    })
  );
}
