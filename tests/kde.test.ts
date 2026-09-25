// KDE Shortcut buttons against a fake busctl that answers like kglobalacceld does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError } from '../server/actions/executor.ts';
import { kdeExecutor } from '../server/actions/kde.ts';
import { componentPath, listKdeShortcuts } from '../server/system/kde.ts';
import type { RunResult, Runner } from '../server/system/process.ts';
import { actionAutoLabel, availableActionTypes } from '../shared/actions-meta.ts';
import { emptyExtState } from '../shared/ext-types.ts';
import { buttonVisual } from '../shared/feedback.ts';
import { emptyObsState } from '../shared/obs-types.ts';
import { ActionSchema } from '../shared/schema.ts';

const info = (id: string, name: string, component: string, componentName: string) => [id, name, component, componentName, 'default', 'Default Context', [], []];

/** busctl --user --json=short -- call org.kde.kglobalaccel <path> <interface> <method> [s value] */
function fakeBusctl(opts: { noPlasma?: boolean; missing?: boolean } = {}) {
  const calls: string[][] = [];
  const ok = (data: unknown): RunResult => ({ code: 0, stdout: `${JSON.stringify({ type: 'x', data })}\n`, stderr: '' });
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (opts.missing) throw Object.assign(new Error('spawn busctl ENOENT'), { code: 'ENOENT' });
    assert.deepEqual(args.slice(0, 5), ['--user', '--json=short', '--', 'call', 'org.kde.kglobalaccel']);
    if (opts.noPlasma) return { code: 1, stdout: '', stderr: 'Call failed: The name org.kde.kglobalaccel was not provided by any .service files\n' };
    const [path, , method] = args.slice(5);
    if (method === 'allComponents') return ok([['/component/kwin', '/component/org_kde_spectacle_desktop', '/component/unused']]);
    if (method === 'allShortcutInfos') {
      if (path === '/component/kwin') return ok([[info('Window Maximize', 'Maximize Window', 'kwin', 'KWin'), info('Overview', 'Toggle Overview', 'kwin', 'KWin')]]);
      if (path === '/component/org_kde_spectacle_desktop') return ok([[info('RectangularRegionScreenShot', '', 'org.kde.spectacle.desktop', 'Spectacle')]]);
      return ok([[]]);
    }
    if (path !== '/component/kwin') return { code: 1, stdout: '', stderr: `Call failed: No such object path '${path}'\n` };
    if (method === 'shortcutNames') return ok([['Window Maximize', 'Overview']]);
    if (method === 'invokeShortcut') return { code: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected ${method}`);
  };
  return { calls, run };
}

test('component paths follow kglobalacceld: anything but letters, digits and _ becomes _', () => {
  assert.equal(componentPath('kwin'), '/component/kwin');
  assert.equal(componentPath('org.kde.spectacle.desktop'), '/component/org_kde_spectacle_desktop');
  assert.equal(componentPath('../../etc'), '/component/______etc');
});

test('the editor gets every app with its shortcuts, by friendly name', async () => {
  const components = await listKdeShortcuts(fakeBusctl().run);
  assert.deepEqual(components, [
    {
      id: 'kwin',
      name: 'KWin',
      shortcuts: [
        { id: 'Window Maximize', name: 'Maximize Window' },
        { id: 'Overview', name: 'Toggle Overview' },
      ],
    },
    { id: 'org.kde.spectacle.desktop', name: 'Spectacle', shortcuts: [{ id: 'RectangularRegionScreenShot', name: 'RectangularRegionScreenShot' }] },
  ]);
});

test('a press checks that the shortcut exists, then invokes it', async () => {
  const { calls, run } = fakeBusctl();
  const press = kdeExecutor(run, 'linux');
  await press({ type: 'kde.shortcut', component: 'kwin', shortcut: 'Overview' }, { kind: 'press' });
  assert.deepEqual(
    calls.map((c) => c.slice(6)),
    [
      ['/component/kwin', 'org.kde.kglobalaccel.Component', 'shortcutNames'],
      ['/component/kwin', 'org.kde.kglobalaccel.Component', 'invokeShortcut', 's', 'Overview'],
    ],
  );
  // KDE would silently ignore an unknown name; the button says so instead.
  await assert.rejects(
    press({ type: 'kde.shortcut', component: 'kwin', shortcut: '--help' }, { kind: 'press' }),
    (err: Error) => err instanceof ActionError && err.message === '“kwin” has no shortcut “--help”',
  );
  await assert.rejects(press({ type: 'kde.shortcut', component: 'nope', shortcut: 'X' }, { kind: 'press' }), /KDE doesn’t know “nope”/);
});

test('outside Plasma, or without busctl, the toast says why', async () => {
  const action = { type: 'kde.shortcut' as const, component: 'kwin', shortcut: 'Overview' };
  await assert.rejects(kdeExecutor(fakeBusctl({ noPlasma: true }).run, 'linux')(action, { kind: 'press' }), /needs a Plasma session/);
  await assert.rejects(kdeExecutor(fakeBusctl({ missing: true }).run, 'linux')(action, { kind: 'press' }), /busctl is missing/);
  await assert.rejects(listKdeShortcuts(fakeBusctl({ noPlasma: true }).run), ActionError);
});

test('on Windows, KDE shortcut buttons refuse without running anything, and are dimmed', async () => {
  const { calls, run } = fakeBusctl();
  const action = { type: 'kde.shortcut' as const, component: 'kwin', shortcut: 'Overview' };
  await assert.rejects(kdeExecutor(run, 'win32')(action, { kind: 'press' }), /only work on Linux/);
  assert.equal(calls.length, 0);
  assert.equal(availableActionTypes(false, 'win32').includes('kde.shortcut'), false, 'the editor doesn’t offer them');
  assert.equal(availableActionTypes(false, 'linux').includes('kde.shortcut'), true);
  const look = (platform?: string) =>
    buttonVisual({ id: 'k', tap: action }, { obs: emptyObsState(), deck: { version: 1, revision: 0, homePageId: 'p', pages: [] }, ext: emptyExtState(), now: 0, platform });
  assert.equal(look('win32').disabled, true);
  assert.equal(look('linux').disabled, undefined);
  assert.equal(look(undefined).disabled, undefined, 'an older server that doesn’t say: assume it can');
});

test('schema and label', () => {
  assert.equal(ActionSchema.safeParse({ type: 'kde.shortcut', component: 'kwin', shortcut: 'Overview' }).success, true);
  assert.equal(ActionSchema.safeParse({ type: 'kde.shortcut', component: '', shortcut: 'Overview' }).success, false);
  assert.equal(actionAutoLabel({ type: 'kde.shortcut', component: 'kwin', shortcut: 'Overview', title: 'Toggle Overview' }, {}), 'Toggle Overview');
  assert.equal(actionAutoLabel({ type: 'kde.shortcut', component: 'kwin', shortcut: 'Overview' }, {}), 'Overview');
});
