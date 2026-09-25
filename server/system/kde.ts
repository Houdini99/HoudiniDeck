// KDE Plasma global shortcuts (kglobalaccel) over D-Bus, through busctl (part of systemd), whose JSON
// output is easy to read. Interface and object paths as in KDE's kglobalacceld.
import type { KdeComponent } from '../../shared/protocol.ts';
import { ActionError } from '../actions/executor.ts';
import type { Runner } from './process.ts';

const SERVICE = 'org.kde.kglobalaccel';
const COMPONENT = 'org.kde.kglobalaccel.Component';

/** kglobalacceld's object path for a component: characters other than A–Z, a–z, 0–9 and _ become _. */
export function componentPath(component: string): string {
  return `/component/${component.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

/** Call a D-Bus method and return its results. `--` keeps names like "--help" from being read as options. */
async function call(run: Runner, path: string, iface: string, method: string, ...args: string[]): Promise<unknown[]> {
  let res;
  try {
    res = await run('busctl', ['--user', '--json=short', '--', 'call', SERVICE, path, iface, method, ...args]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ActionError('busctl is missing on the PC (it comes with systemd)');
    throw err;
  }
  if (res.code !== 0) {
    const message = res.stderr.trim();
    if (/not provided by any \.service files|ServiceUnknown/i.test(message)) {
      throw new ActionError('KDE’s shortcut service isn’t running (this needs a Plasma session)');
    }
    throw new ActionError(message.replace(/^Call failed: /, '') || `busctl: exit code ${res.code}`);
  }
  if (!res.stdout.trim()) return []; // a method without results
  return (JSON.parse(res.stdout) as { data: unknown[] }).data;
}

/** Every component with its shortcuts, for the editor. */
export async function listKdeShortcuts(run: Runner): Promise<KdeComponent[]> {
  const [paths] = (await call(run, '/kglobalaccel', 'org.kde.KGlobalAccel', 'allComponents')) as [string[]];
  const components: KdeComponent[] = [];
  for (const path of paths ?? []) {
    // a(ssssssaiai): unique name, friendly name, component unique, component friendly, context…, keys
    const [infos] = (await call(run, path, COMPONENT, 'allShortcutInfos')) as [string[][]];
    if (!infos?.length) continue;
    const [, , componentId, componentName] = infos[0];
    components.push({
      id: componentId,
      name: componentName || componentId,
      shortcuts: infos.map(([id, name]) => ({ id, name: name || id })).sort((a, b) => a.name.localeCompare(b.name)),
    });
  }
  return components.sort((a, b) => a.name.localeCompare(b.name));
}

/** KDE silently ignores unknown shortcut names, so check first and say so. */
export async function invokeKdeShortcut(run: Runner, component: string, shortcut: string): Promise<void> {
  const path = componentPath(component);
  let names: string[];
  try {
    [names] = (await call(run, path, COMPONENT, 'shortcutNames')) as [string[]];
  } catch (err) {
    if (err instanceof ActionError && /No such object|UnknownObject/i.test(err.message)) {
      throw new ActionError(`KDE doesn’t know “${component}”`);
    }
    throw err;
  }
  if (!names?.includes(shortcut)) throw new ActionError(`“${component}” has no shortcut “${shortcut}”`);
  await call(run, path, COMPONENT, 'invokeShortcut', 's', shortcut);
}
