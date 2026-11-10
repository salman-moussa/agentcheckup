// `npm run demo`: builds a fake unhealthy setup in a temp folder and opens its report.
// Safe to share in screenshots: nothing here comes from your real machine.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHome } from './fixture.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcheckup-demo-'));
makeHome(home);
const cli = fileURLToPath(new URL('../bin/agentcheckup.js', import.meta.url));
spawn(process.execPath, [cli, '--home', home, ...process.argv.slice(2)], { stdio: 'inherit' }).on('exit', (code) => {
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(code ?? 0);
});
