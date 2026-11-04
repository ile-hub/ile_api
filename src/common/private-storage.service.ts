import sharp from 'sharp';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestContextService } from './request-context.service';
export interface UploadedAsset {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}
export const EVIDENCE_BUCKET = 'leri-evidence-private-v2';
export const PHOTO_BUCKET = 'leri-property-photos-v2';
export const FILE_LIMIT = 5 * 1024 * 1024;

export function safeFileName(name: string): string {
  return [...name]
    .map((c) => (c.charCodeAt(0) < 32 || c === '/' || c === '\\' ? '_' : c))
    .join('')
    .slice(0, 150);
}
export function validateAsset(
  file: UploadedAsset | undefined,
  photo = false,
): UploadedAsset {
  if (
    !file?.buffer?.length ||
    file.buffer.length > FILE_LIMIT ||
    file.size !== file.buffer.length
  )
    throw new BadRequestException('A file of 1 byte to 5 MiB is required');
  const b = file.buffer;
  const png = b
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = b.length >= 4 && b[0] === 255 && b[1] === 216 && b[2] === 255;
  const webp =
    b.length >= 12 &&
    b.toString('ascii', 0, 4) === 'RIFF' &&
    b.toString('ascii', 8, 12) === 'WEBP';
  const pdf =
    b.toString('ascii', 0, 5) === '%PDF-' &&
    b.subarray(-1024).includes(Buffer.from('%%EOF'));
  const valid =
    (file.mimetype === 'image/png' && png) ||
    (file.mimetype === 'image/jpeg' && jpeg) ||
    (photo && file.mimetype === 'image/webp' && webp) ||
    (!photo && file.mimetype === 'application/pdf' && pdf);
  if (!valid)
    throw new BadRequestException(
      photo
        ? 'Photo must be PNG, JPEG or WebP with matching content'
        : 'Document must be PDF, PNG or JPEG with matching content',
    );
  return file;
}
// Public gallery images are decoded/re-encoded to remove EXIF/GPS and other metadata.
export async function preparePropertyPhoto(
  input: UploadedAsset | undefined,
): Promise<UploadedAsset> {
  const file = validateAsset(input, true);
  try {
    const format =
      file.mimetype === 'image/png'
        ? 'png'
        : file.mimetype === 'image/jpeg'
          ? 'jpeg'
          : 'webp';
    const buffer = await sharp(file.buffer, {
      limitInputPixels: 20_000_000,
      failOn: 'warning',
      animated: false,
    })
      .rotate()
      .toFormat(format)
      .timeout({ seconds: 10 })
      .toBuffer();
    if (buffer.length > FILE_LIMIT)
      throw new Error('Normalised photo is too large');
    return { ...file, buffer, size: buffer.length };
  } catch {
    throw new BadRequestException(
      'Photo cannot be decoded safely within the 20 megapixel and 5 MiB limits',
    );
  }
}
@Injectable()
export class PrivateStorageService {
  constructor(
    private readonly config: ConfigService,
    private readonly context: RequestContextService,
  ) {}
  private base() {
    return (
      this.config.getOrThrow<string>('SUPABASE_URL').replace(/\/$/, '') +
      '/storage/v1'
    );
  }
  private headers(token: string) {
    return {
      apikey: this.config.getOrThrow<string>('SUPABASE_ANON_KEY'),
      Authorization: `Bearer ${token}`,
    };
  }
  private async request(url: string, init: RequestInit) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
    } catch {
      throw new ServiceUnavailableException('Private storage is unavailable');
    }
  }
  async upload(bucket: string, path: string, file: UploadedAsset) {
    const token = this.context.getAccessToken();
    // Register before I/O so an ambiguous upload timeout is also compensated.
    this.context.onRollback(() => this.remove(bucket, path, token));
    const response = await this.request(
      `${this.base()}/object/${bucket}/${path}`,
      {
        method: 'POST',
        headers: {
          ...this.headers(token),
          'Content-Type': file.mimetype,
          'x-upsert': 'false',
        },
        body: new Uint8Array(file.buffer),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new ServiceUnavailableException('Private storage upload failed');
  }
  async remove(
    bucket: string,
    path: string,
    token = this.context.getAccessToken(),
  ) {
    const response = await this.request(`${this.base()}/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...this.headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Private storage removal failed; retry removal',
      );
  }
  async download(
    bucket: string,
    path: string,
    token = this.context.getAccessToken(),
  ) {
    const response = await this.request(
      `${this.base()}/object/sign/${bucket}/${path}`,
      {
        method: 'POST',
        headers: {
          ...this.headers(token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 60 }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if ([400, 403, 404].includes(response.status))
      throw new NotFoundException();
    if (!response.ok)
      throw new ServiceUnavailableException('Private storage is unavailable');
    const result = (await response.json()) as { signedURL: string };
    return { url: this.base() + result.signedURL, expiresIn: 60 };
  }
}
