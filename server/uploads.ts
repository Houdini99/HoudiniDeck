// Button images and Play Sound clips uploaded from the editor. Stored under a content hash in data/uploads/.
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { SOUND_NAME_RE, UPLOAD_NAME_RE } from '../shared/deck-utils.ts';
import { bearerKey, isTrustedLocal, keyMatches, originAllowed } from './auth.ts';
import type { SettingsStore } from './store/settings-store.ts';
import { writeFileAtomic } from './store/files.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_SOUND_BYTES = 15 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_SOUND_BYTES);

export const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
} as const;
type Ext = keyof typeof IMAGE_MIME;

export const SOUND_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav' } as const;
type SoundExt = keyof typeof SOUND_MIME;

/** Identify an MP3 or WAV file from its bytes (both play on Linux and Windows alike). */
export function sniffSound(buf: Buffer): SoundExt | undefined {
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'wav';
  if (head.startsWith('ID3')) return 'mp3';
  // A bare MPEG audio frame: 11 sync bits, then MPEG version and layer III.
  if (buf.length >= 4 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) === 0x02) return 'mp3';
  return undefined;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Identify the image type from its bytes; the file name and declared type aren't trusted. */
export function sniffImage(buf: Buffer): Ext | undefined {
  if (buf.subarray(0, 8).equals(PNG_MAGIC)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  const head = buf.subarray(0, 12).toString('latin1');
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'webp';
  const text = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  if ((text.startsWith('<svg') || text.startsWith('<?xml') || text.startsWith('<!--')) && /<svg[\s>]/.test(text)) return 'svg';
  return undefined;
}

export function registerUploadRoutes(app: FastifyInstance, deps: { dataDir: string; settingsStore: SettingsStore }): void {
  const dir = join(deps.dataDir, 'uploads');

  app.post('/api/uploads', async (req, reply) => {
    const { host, origin, authorization } = req.headers;
    if (!originAllowed(origin, host)) return reply.code(403).send({ error: 'Origin not allowed' });
    const authorized =
      isTrustedLocal(req.socket.remoteAddress, host) || keyMatches(bearerKey(authorization), deps.settingsStore.settings.accessKey);
    if (!authorized) return reply.code(401).send({ error: 'Pair this device first' });

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'No file received' });
    const buf = await part.toBuffer();
    const ext = sniffImage(buf) ?? sniffSound(buf);
    if (!ext) return reply.code(415).send({ error: 'Use a PNG, JPEG, WebP, GIF or SVG image, or an MP3 or WAV sound' });
    const limit = ext in SOUND_MIME ? MAX_SOUND_BYTES : MAX_IMAGE_BYTES;
    if (buf.length > limit) return reply.code(413).send({ error: `That file is too big (at most ${limit / 1024 / 1024} MB)` });

    const file = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
    const path = join(dir, file);
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) await writeFileAtomic(path, buf);
    return { file };
  });

  app.get<{ Params: { file: string } }>('/uploads/:file', async (req, reply) => {
    const { file } = req.params;
    if (!UPLOAD_NAME_RE.test(file) && !SOUND_NAME_RE.test(file)) return reply.code(404).send({ error: 'Not found' });
    let buf: Buffer;
    try {
      buf = await readFile(join(dir, file));
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
    const ext = file.slice(file.lastIndexOf('.') + 1);
    const mime = ext in SOUND_MIME ? SOUND_MIME[ext as SoundExt] : IMAGE_MIME[ext as Ext];
    return reply
      .type(mime)
      .header('x-content-type-options', 'nosniff')
      // An uploaded SVG opened directly must not be able to run script on this origin.
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(buf);
  });
}
