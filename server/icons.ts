// Built-in icon sets (Material Design Icons, Simple Icons brand logos), served one SVG at a time.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { ICON_NAME_RE, ICON_SETS, type IconSet } from '../shared/deck-utils.ts';

interface IconifyJson {
  prefix: string;
  width?: number;
  height?: number;
  icons: Record<string, { body: string; width?: number; height?: number; hidden?: boolean }>;
  aliases?: Record<string, { parent: string; hidden?: boolean }>;
}

const require = createRequire(import.meta.url);
const sets = new Map<IconSet, Promise<IconifyJson>>();

function loadSet(set: IconSet): Promise<IconifyJson> {
  let loading = sets.get(set);
  if (!loading) {
    loading = readFile(require.resolve(`@iconify-json/${set}/icons.json`), 'utf8').then((t) => JSON.parse(t) as IconifyJson);
    sets.set(set, loading);
  }
  return loading;
}

export function renderIcon(json: IconifyJson, name: string): string | undefined {
  let resolved = name;
  let icon = json.icons[resolved];
  for (let hops = 0; !icon && json.aliases?.[resolved] && hops < 5; hops++) {
    resolved = json.aliases[resolved].parent;
    icon = json.icons[resolved];
  }
  if (!icon) return undefined;
  const w = icon.width ?? json.width ?? 24;
  const h = icon.height ?? json.height ?? 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${icon.body}</svg>`;
}

function iconNames(json: IconifyJson): string[] {
  const names = Object.entries(json.icons)
    .filter(([, icon]) => !icon.hidden)
    .map(([name]) => name);
  const aliases = Object.entries(json.aliases ?? {})
    .filter(([, alias]) => !alias.hidden)
    .map(([name]) => name);
  return [...names, ...aliases].sort();
}

const isIconSet = (set: string): set is IconSet => (ICON_SETS as readonly string[]).includes(set);

export function registerIconRoutes(app: FastifyInstance): void {
  app.get<{ Params: { set: string; file: string } }>('/icons/:set/:file', async (req, reply) => {
    const { set, file } = req.params;
    const name = file.replace(/\.svg$/, '');
    if (!isIconSet(set) || !ICON_NAME_RE.test(name)) return reply.code(404).send({ error: 'Unknown icon' });
    const svg = renderIcon(await loadSet(set), name);
    if (!svg) return reply.code(404).send({ error: 'Unknown icon' });
    return reply.type('image/svg+xml').header('cache-control', 'public, max-age=604800').send(svg);
  });

  // Name list for the editor's icon picker.
  app.get<{ Params: { set: string } }>('/api/icons/:set', async (req, reply) => {
    const { set } = req.params;
    if (!isIconSet(set)) return reply.code(404).send({ error: 'Unknown icon set' });
    return reply.header('cache-control', 'public, max-age=86400').send({ set, names: iconNames(await loadSet(set)) });
  });
}
