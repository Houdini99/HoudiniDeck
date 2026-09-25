// Stands in for server/system/windows/helper.ps1 in tests: the same JSON lines, and requests that
// misbehave on purpose. FAKE_HELPER_FAIL=1 makes it fail to start.
import { createInterface } from 'node:readline';

const write = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

if (process.env.FAKE_HELPER_FAIL) {
  process.stderr.write('Add-Type : compilation failed\n');
  process.exit(3);
}

console.log('some stray output that is not JSON');
write({ event: 'ready' });

createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  switch (req.op) {
    case 'echo':
      return write({ id: req.id, ok: true, data: { raw: line, ...req } });
    case 'fail':
      return write({ id: req.id, ok: false, error: 'Element nicht gefunden' });
    case 'crash':
      return process.exit(1);
    case 'hang':
      return;
    case 'media.watch':
      if (req.on) write({ event: 'media', state: { current: null, sessions: [] } });
      return write({ id: req.id, ok: true, data: null });
    default:
      return write({ id: req.id, ok: false, error: `Unknown request: ${req.op}` });
  }
});
