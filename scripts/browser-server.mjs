// Isolated test API: never uses the live preview database or dist/web.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const dir = await mkdtemp(join(tmpdir(), 'canvas-browser-'));
const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', 'src/http/main.ts'], {
  stdio: 'inherit', env: { ...process.env, WORKFLOW_CANVAS_HOST: '127.0.0.1', WORKFLOW_CANVAS_PORT: '18787',
    WORKFLOW_CANVAS_ALLOWED_ORIGINS: 'http://127.0.0.1:18787', WORKFLOW_CANVAS_DB: join(dir, 'test.sqlite'),
    WORKFLOW_CANVAS_STATIC: 'dist/theme-test-web' },
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', async code => { await rm(dir, { recursive: true, force: true }); process.exit(code ?? 0); });
