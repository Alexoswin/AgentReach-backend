import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { Connection, mongo } from 'mongoose';
import { MongoService } from '../mongo.service';
import type { MailAttachmentRef } from '../schemas/mail-message.schema';

const BUCKET_NAME = 'mailAttachments';
// Campaign messages share their attachment files, so the send queue keeps
// recently read ones in memory instead of reading the same file per email.
const CACHE_LIMIT_BYTES = 64 * 1024 * 1024;

type StoredFile = {
  _id: string;
  length: number;
  filename: string;
  metadata?: { ownerId?: string; contentType?: string };
};

/** Mailbox attachments, stored in MongoDB GridFS and scoped to their owner. */
@Injectable()
export class MailAttachmentsService {
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly db: MongoService,
  ) {}

  private bucket() {
    return new mongo.GridFSBucket(this.connection.db!, {
      bucketName: BUCKET_NAME,
    });
  }

  async save(
    ownerId: string,
    file: { name: string; contentType: string; content: Buffer },
  ): Promise<MailAttachmentRef> {
    const fileId = randomUUID();
    const contentType = file.contentType || 'application/octet-stream';
    await new Promise<void>((resolve, reject) => {
      const upload = this.bucket().openUploadStreamWithId(
        fileId as any,
        file.name,
        { metadata: { ownerId, contentType } },
      );
      upload.once('finish', () => resolve());
      upload.once('error', reject);
      upload.end(file.content);
    });
    return {
      fileId,
      name: file.name,
      contentType,
      size: file.content.length,
    };
  }

  /** Template attachments are stored inline as base64; copy them in once. */
  async saveTemplateAttachments(
    ownerId: string,
    attachments: {
      name?: string;
      contentType?: string;
      contentBase64?: string;
    }[] = [],
  ) {
    const saved: MailAttachmentRef[] = [];
    for (const attachment of attachments) {
      if (!attachment?.name || !attachment?.contentBase64) continue;
      saved.push(
        await this.save(ownerId, {
          name: attachment.name,
          contentType: attachment.contentType || 'application/octet-stream',
          content: Buffer.from(attachment.contentBase64, 'base64'),
        }),
      );
    }
    return saved;
  }

  async find(ownerId: string, fileId: string): Promise<StoredFile | null> {
    const [file] = await this.bucket()
      .find({ _id: fileId as any, 'metadata.ownerId': ownerId })
      .limit(1)
      .toArray();
    return (file as unknown as StoredFile) || null;
  }

  async openDownload(ownerId: string, fileId: string) {
    const file = await this.find(ownerId, fileId);
    if (!file) throw new NotFoundException('Attachment not found');
    return {
      file,
      contentType: file.metadata?.contentType || 'application/octet-stream',
      stream: this.bucket().openDownloadStream(fileId as any),
    };
  }

  async read(ownerId: string, fileId: string): Promise<Buffer> {
    const cached = this.cache.get(fileId);
    if (cached) return cached;

    const { stream } = await this.openDownload(ownerId, fileId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks);
    this.remember(fileId, content);
    return content;
  }

  private remember(fileId: string, content: Buffer) {
    if (content.length > CACHE_LIMIT_BYTES / 4) return;
    this.cache.set(fileId, content);
    this.cacheBytes += content.length;
    for (const [key, value] of this.cache) {
      if (this.cacheBytes <= CACHE_LIMIT_BYTES) break;
      this.cache.delete(key);
      this.cacheBytes -= value.length;
    }
  }

  /** Deletes the files no message refers to any more. */
  async deleteUnreferenced(ownerId: string, fileIds: string[]) {
    for (const fileId of new Set(fileIds)) {
      const references = await this.db.mailMessage.count({
        where: { ownerId, 'attachments.fileId': fileId },
      });
      if (references > 0) continue;
      const file = await this.find(ownerId, fileId);
      if (file) await this.bucket().delete(fileId as any);
    }
  }
}
