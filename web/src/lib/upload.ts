// Uploads a button image or sound to the server (data/uploads/), which names it by its content.
import { getKey } from './key.ts';

/** Returns the stored file's name, e.g. "3f2a…9c.mp3". Throws with the server's message on failure. */
export async function uploadFile(file: Blob, name: string): Promise<string> {
  const form = new FormData();
  form.append('file', file, name);
  const key = getKey();
  const res = await fetch('/api/uploads', { method: 'POST', body: form, headers: key ? { Authorization: `Bearer ${key}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Upload failed (HTTP ${res.status})`);
  return body.file;
}
