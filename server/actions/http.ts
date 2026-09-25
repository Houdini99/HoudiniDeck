// The http.* family: webhooks for Home Assistant, Streamer.bot, a Philips Hue bridge, …
import type { ActionOf } from '../../shared/schema.ts';
import { errorMessage, type Logger } from '../log.ts';
import { ActionError, type Executor } from './executor.ts';

export const DEFAULT_TIMEOUT_MS = 10_000;

export function httpExecutor(log: Logger): Executor<'http'> {
  return (action) => sendRequest(action, log);
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part; // a stray % is taken literally
  }
}

function looksLikeJson(body: string): boolean {
  const text = body.trim();
  if (!text.startsWith('{') && !text.startsWith('[')) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Why fetch failed, in words for the toast. */
function failure(err: unknown, url: URL, timeoutMs: number): string {
  if ((err as Error)?.name === 'TimeoutError') return `no answer within ${timeoutMs / 1000} s`;
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? '';
  if (code === 'ECONNREFUSED') return 'connection refused (is it running?)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'host unreachable';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'the connection was dropped';
  if (code === 'UND_ERR_CONNECT_TIMEOUT') return 'could not connect (timed out)';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return `its HTTPS certificate isn't trusted (${code})`;
  if (cause?.message === 'bad port') return `port ${url.port} is blocked for web requests`;
  return cause?.message || errorMessage(err);
}

export async function sendRequest(action: ActionOf<'http.request'>, log: Logger): Promise<void> {
  const url = new URL(action.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ActionError('Webhooks need an http:// or https:// URL');
  let headers: Headers;
  try {
    headers = new Headers(action.headers);
  } catch (err) {
    throw new ActionError(`Webhook: invalid header (${errorMessage(err)})`);
  }
  // fetch refuses URLs with a user and password in them; send those the way curl does.
  if (url.username || url.password) {
    const credentials = `${decode(url.username)}:${decode(url.password)}`;
    if (!headers.has('authorization')) headers.set('authorization', `Basic ${Buffer.from(credentials).toString('base64')}`);
    url.username = '';
    url.password = '';
  }
  const body = action.method === 'GET' || !action.body ? undefined : action.body;
  if (body !== undefined && !headers.has('content-type') && looksLikeJson(body)) headers.set('content-type', 'application/json');

  const timeoutMs = action.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let res: Response;
  try {
    // Redirects are followed, but fetch only ever follows them to http(s) URLs.
    res = await fetch(url, { method: action.method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const why = failure(err, url, timeoutMs);
    log.debug(`Webhook ${action.method} ${url.host} failed: ${why}`);
    throw new ActionError(`Webhook to ${url.host} failed: ${why}`);
  }
  await res.body?.cancel().catch(() => {}); // the answer isn't used; free the connection
  log.debug(`Webhook ${action.method} ${url.host} → ${res.status} in ${Date.now() - started} ms`);
  if (!res.ok) throw new ActionError(`Webhook to ${url.host} failed: ${res.status} ${res.statusText}`.trimEnd());
}
