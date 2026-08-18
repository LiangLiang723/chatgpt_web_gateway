import type { FastifyInstance } from 'fastify';

import { AttachmentPipelineError } from '../../attachments/errors.js';
import type { FileService } from '../../attachments/file-service.js';
import {
  isFilePurpose,
  isSafeLogicalFilename,
  type FilePurpose,
} from '../../attachments/policy.js';
import { InvalidRequestError } from '../errors.js';
import {
  contentDisposition,
  encodeDeletedFile,
  encodePublicFile,
  encodePublicFileList,
} from '../files.js';

function invalidUpload(message: string): AttachmentPipelineError {
  return new AttachmentPipelineError('invalid_file_upload', message);
}

interface FilePathParams {
  id: string;
}

interface FileListQuery {
  after?: string | string[];
  limit?: string | string[];
  order?: string | string[];
  purpose?: string | string[];
  [key: string]: string | string[] | undefined;
}

function queryString(value: string | string[] | undefined, param: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidRequestError(`${param} must be a string`, param);
  return value;
}

export function registerFilesRoute(app: FastifyInstance, fileService: FileService): void {
  app.post('/v1/files', async (request, reply) => {
    if (!request.isMultipart()) throw invalidUpload('Request must use multipart/form-data');

    let privateFileId: string | undefined;
    let purpose: FilePurpose | undefined;
    let sawPurpose = false;

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || privateFileId !== undefined) {
            part.file.resume();
            throw invalidUpload('Exactly one file part is required');
          }
          if (!isSafeLogicalFilename(part.filename)) {
            part.file.resume();
            throw invalidUpload('File filename is invalid');
          }
          const stored = await fileService.createPrivateFile({
            filename: part.filename,
            mimeType: part.mimetype,
            source: part.file,
          });
          privateFileId = stored.id;
          continue;
        }

        if (part.fieldname !== 'purpose') {
          throw invalidUpload(`Unsupported multipart field: ${part.fieldname}`);
        }
        if (sawPurpose || typeof part.value !== 'string' || part.valueTruncated) {
          throw invalidUpload('Exactly one valid purpose field is required');
        }
        sawPurpose = true;
        if (!isFilePurpose(part.value)) throw invalidUpload('File purpose is invalid');
        purpose = part.value;
      }

      if (!privateFileId) throw invalidUpload('Exactly one file part is required');
      if (!purpose) throw invalidUpload('File purpose is required');

      const file = fileService.promotePrivateFile(privateFileId, purpose);
      privateFileId = undefined;
      return reply.send(encodePublicFile(file));
    } catch (error) {
      if (privateFileId) await fileService.discardPrivateFile(privateFileId);
      throw error;
    }
  });

  app.get<{ Querystring: FileListQuery }>('/v1/files', async (request, reply) => {
    const allowed = new Set(['after', 'limit', 'order', 'purpose']);
    for (const key of Object.keys(request.query)) {
      if (!allowed.has(key))
        throw new InvalidRequestError(`Unsupported query parameter: ${key}`, key);
    }

    const after = queryString(request.query.after, 'after');
    const limitRaw = queryString(request.query.limit, 'limit');
    const orderRaw = queryString(request.query.order, 'order');
    const purposeRaw = queryString(request.query.purpose, 'purpose');

    const limit = limitRaw === undefined ? 10_000 : Number(limitRaw);
    if (
      !/^\d+$/.test(limitRaw ?? '10000') ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10_000
    ) {
      throw new InvalidRequestError('limit must be an integer between 1 and 10000', 'limit');
    }
    const order = orderRaw ?? 'desc';
    if (order !== 'asc' && order !== 'desc') {
      throw new InvalidRequestError('order must be asc or desc', 'order');
    }
    if (purposeRaw !== undefined && !isFilePurpose(purposeRaw)) {
      throw new InvalidRequestError('purpose is invalid', 'purpose');
    }

    const page = fileService.listPublicFiles({
      ...(after === undefined ? {} : { after }),
      limit,
      order,
      ...(purposeRaw === undefined ? {} : { purpose: purposeRaw }),
    });
    if (!page) throw new InvalidRequestError('after cursor was not found', 'after');
    return reply.send(encodePublicFileList(page.files, page.hasMore));
  });

  app.get<{ Params: FilePathParams }>('/v1/files/:id', async (request, reply) => {
    const file = fileService.getPublicFile(request.params.id);
    if (!file) throw new AttachmentPipelineError('file_not_found', 'File resource was not found');
    return reply.send(encodePublicFile(file));
  });

  app.get<{ Params: FilePathParams }>('/v1/files/:id/content', async (request, reply) => {
    const content = await fileService.openPublicContent(request.params.id);
    reply.header('content-type', content.file.mimeType ?? 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(content.file.filename));
    return reply.send(content.stream);
  });

  app.delete<{ Params: FilePathParams }>('/v1/files/:id', async (request, reply) => {
    const deleted = await fileService.deletePublicFile(request.params.id);
    return reply.send(encodeDeletedFile(deleted));
  });
}
