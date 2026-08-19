export type AttachmentDescriptor =
  | {
      id: string;
      kind: 'image';
      source:
        | { type: 'url'; url: string }
        | { type: 'data_url'; dataUrl: string }
        | { type: 'file_id'; fileId: string };
    }
  | {
      id: string;
      kind: 'file';
      source:
        { type: 'file_id'; fileId: string } | { type: 'base64'; data: string; filename?: string };
    };
