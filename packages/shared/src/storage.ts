import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface SignedUpload {
  url: string;
  method: 'PUT';
  /** The client must send exactly these headers; they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** Private, tenant-prefixed object storage. Buckets are never public; downloads use short-lived signed URLs. */
export interface ObjectStorage {
  check(): Promise<void>;
  presignUpload(key: string, opts: { contentType: string; size: number; ttlSeconds: number }): Promise<SignedUpload>;
  presignDownload(key: string, opts: { fileName: string; ttlSeconds: number }): Promise<string>;
  head(key: string): Promise<{ size: number } | null>;
  downloadTo(key: string, path: string): Promise<void>;
  delete(key: string): Promise<void>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** Every object under `prefix` (all pages). Only for the store clean-up after a reset (ADR 022). */
  list(prefix: string): Promise<StoredObject[]>;
  /** Deletes the keys in batches of 1,000; one request per key where multi-object delete is not implemented. */
  deleteMany(keys: string[]): Promise<{ deleted: number; failed: number }>;
}
export interface StoredObject { key: string; size: number; lastModified: Date }

/** Keys are always built here, never from client input, and always carry the tenant prefix. */
export const storageKeys = {
  upload: (tenantId: string, uploadId: string, ext: string) => `tenants/${tenantId}/uploads/${uploadId}/original${ext}`,
  generated: (tenantId: string, fileId: string, ext: string) => `tenants/${tenantId}/generated/${fileId}${ext}`,
};

export interface S3Options {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly opts: S3Options) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      forcePathStyle: opts.forcePathStyle ?? false,
      ...(opts.accessKeyId && opts.secretAccessKey ? { credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey } } : {}),
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
  }
  async check() { await this.client.send(new HeadBucketCommand({ Bucket: this.opts.bucket }), { abortSignal: AbortSignal.timeout(1500) }); }
  async presignUpload(key: string, o: { contentType: string; size: number; ttlSeconds: number }): Promise<SignedUpload> {
    // ContentLength and ContentType are signed: storage rejects an upload of a different size or type.
    const command = new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, ContentType: o.contentType, ContentLength: o.size, ServerSideEncryption: 'AES256' });
    const url = await getSignedUrl(this.client, command, { expiresIn: o.ttlSeconds, signableHeaders: new Set(['content-type', 'content-length']) });
    return {
      url, method: 'PUT',
      headers: { 'Content-Type': o.contentType, 'x-amz-server-side-encryption': 'AES256' },
      expiresAt: new Date(Date.now() + o.ttlSeconds * 1000),
    };
  }
  presignDownload(key: string, o: { fileName: string; ttlSeconds: number }) {
    const safe = o.fileName.replace(/[^A-Za-z0-9._-]/g, '_');
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${safe}"` }), { expiresIn: o.ttlSeconds });
  }
  async head(key: string) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { size: r.ContentLength ?? 0 };
    } catch (e) {
      if ((e as { name?: string }).name === 'NotFound' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
  async downloadTo(key: string, path: string) {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    await pipeline(r.Body as Readable, createWriteStream(path));
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: key }));
  }
  async put(key: string, data: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: data, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async list(prefix: string) {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.opts.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified ?? new Date(0) });
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
  async deleteMany(keys: string[]) {
    let deleted = 0, failed = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        const r = await this.client.send(new DeleteObjectsCommand({ Bucket: this.opts.bucket, Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true } }));
        failed += r.Errors?.length ?? 0;
        deleted += batch.length - (r.Errors?.length ?? 0);
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status && status !== 501 && (e as { name?: string }).name !== 'NotImplemented') throw e;
        for (const key of batch) {
          try { await this.delete(key); deleted++; } catch { failed++; }
        }
      }
    }
    return { deleted, failed };
  }
}

/** In-memory storage for tests and local development without an object store. Never use in production. */
export class MemoryStorage implements ObjectStorage {
  async check() {}
  readonly objects = new Map<string, Buffer>();
  readonly downloads = new Map<string, { key: string; expiresAt: number }>();
  async presignUpload(key: string, o: { contentType: string; size: number; ttlSeconds: number }): Promise<SignedUpload> {
    return { url: `memory://${key}`, method: 'PUT', headers: { 'Content-Type': o.contentType }, expiresAt: new Date(Date.now() + o.ttlSeconds * 1000) };
  }
  async presignDownload(key: string, opts: { fileName: string; ttlSeconds: number }) {
    const url = `memory://download/${randomUUID()}`;
    this.downloads.set(url, { key, expiresAt: Date.now() + opts.ttlSeconds * 1000 });
    return url;
  }
  async put(key: string, data: Buffer) { this.objects.set(key, data); this.modified.set(key, new Date()); }
  async head(key: string) { const o = this.objects.get(key); return o ? { size: o.length } : null; }
  async downloadTo(key: string, path: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error('Object not found');
    await writeFile(path, o);
  }
  async delete(key: string) { this.objects.delete(key); this.modified.delete(key); }
  /** Last-modified times; put() stamps now, tests may backdate. */
  readonly modified = new Map<string, Date>();
  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, data]) => ({ key, size: data.length, lastModified: this.modified.get(key) ?? new Date(0) }));
  }
  async deleteMany(keys: string[]) {
    let deleted = 0;
    for (const k of keys) if (this.objects.delete(k)) { this.modified.delete(k); deleted++; }
    return { deleted, failed: keys.length - deleted };
  }
}
