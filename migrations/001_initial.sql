CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  conversation_key TEXT UNIQUE,
  chatgpt_conversation_url TEXT,
  instructions_json TEXT NOT NULL CHECK (json_valid(instructions_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  tool_choice_json TEXT NOT NULL CHECK (json_valid(tool_choice_json)),
  tool_fingerprint TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_used_at INTEGER NOT NULL CHECK (last_used_at >= 0)
) STRICT;

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  tool_call_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  UNIQUE (conversation_id, sequence)
) STRICT;

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  external_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_text TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (conversation_id, external_call_id)
) STRICT;

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
) STRICT;

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  local_attachment_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  source_json TEXT NOT NULL CHECK (json_valid(source_json)),
  file_id TEXT REFERENCES files(id),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (message_id, local_attachment_id)
) STRICT;

CREATE TABLE generated_images (
  id TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE INDEX idx_messages_conversation_sequence
  ON messages(conversation_id, sequence);
CREATE INDEX idx_tool_calls_conversation_external
  ON tool_calls(conversation_id, external_call_id);
CREATE INDEX idx_attachments_conversation_message
  ON attachments(conversation_id, message_id);
CREATE INDEX idx_attachments_file
  ON attachments(file_id);
CREATE INDEX idx_files_sha256
  ON files(sha256);
CREATE INDEX idx_generated_images_conversation_created
  ON generated_images(conversation_id, created_at);
