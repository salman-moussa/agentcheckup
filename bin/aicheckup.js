#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { purge, redactHistory, undo } from '../src/fix.js';
import { checkLeaks } from '../src/leaks.js';
import { renderReport } from '../src/report.js';
import { scan, VERSION } from '../src/scan.js';
import { serve } from '../src/server.js';
import { locate, pretty, TOOLS } from '../src/sources.js';

const HELP = `aicheckup ${VERSION}
Health check for your AI coding setup. Runs on this machine only.

Usage
  npx aicheckup            scan and open the report in your browser
  npx aicheckup fix        replace secrets in chat history with [REDACTED] (backs up first)
  npx aicheckup undo       restore the files changed by the last fix
  npx aicheckup purge      delete the backups (they still contain the secrets)

Options
  --json             print the result as JSON and exit
  --html <file>      write the report to a file instead of opening it
  --only <tools>     comma list of: ${Object.keys(TOOLS).join(', ')}
  --fail-under <n>   exit with code 1 when the score is below n (for CI)
  --no-open          start the report server but do not open the browser
  --yes              do not ask before fix
  --home <dir>       scan this folder as the home folder (testing and demos)
  -h, --help         show this help
  -v, --version      show the version`;

function die(msg) {
  console.error(msg);
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      html: { type: 'string' },
      only: { type: 'string' },
      'fail-under': { type: 'string' },
      'no-open': { type: 'boolean' },
      yes: { type: 'boolean' },
      home: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });
} catch (e) {
  die(`${e.message}\n\n${HELP}`);
}
const { values: opt, positionals } = args;
const command = positionals[0] || 'scan';

if (opt.help) {
  console.log(HELP);
  process.exit(0);
}
if (opt.version) {
  console.log(VERSION);
  process.exit(0);
}

const only = opt.only?.split(',').map((s) => s.trim()).filter(Boolean);
for (const t of only || []) if (!Object.hasOwn(TOOLS, t)) die(`Unknown tool "${t}". Use: ${Object.keys(TOOLS).join(', ')}`);
// A custom home ignores real env paths so nothing outside that folder is read.
const base = opt.home ? { home: opt.home, env: {} } : {};
const r = locate(base.home, base.env);
const tty = process.stderr.isTTY && !opt.json;

let lastTick = 0;
function onProgress(done, total) {
  if (!tty || (Date.now() - lastTick < 120 && done < total)) return;
  lastTick = Date.now();
  process.stderr.write(`\r  Scanning chat history  ${Math.round((done / total) * 100)}%`);
}
const clearProgress = () => tty && process.stderr.write('\r' + ' '.repeat(40) + '\r');

async function runScan() {
  const data = await scan({ ...base, only, onProgress });
  clearProgress();
  return data;
}

function printSummary(data) {
  if (data.score == null) return console.log('\n  No AI coding tools found (looked for Claude Code, Codex, Cursor).\n');
  const tools = Object.values(data.tools).filter((t) => t.scanned).map((t) => t.label).join(', ');
  console.log(`\n  aicheckup  ${data.score}/100  ${data.grade}`);
  console.log(`  ${tools}\n`);
  for (const c of data.categories) {
    const bar = '█'.repeat(Math.round(c.score / 10)).padEnd(10, '░');
    console.log(`  ${c.label.padEnd(7)} ${bar} ${String(c.score).padStart(3)}`);
  }
  const top = data.findings.filter((f) => f.severity !== 'info').slice(0, 6);
  if (top.length) console.log('');
  for (const f of top) console.log(`  ${f.severity.toUpperCase().padEnd(6)} ${f.title}`);
  console.log('');
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref();
  } catch {
    /* no browser: the URL is printed anyway */
  }
}

if (command === 'scan') {
  const data = await runScan();
  const failUnder = opt['fail-under'] ? Number(opt['fail-under']) : null;
  const code = failUnder != null && data.score != null && data.score < failUnder ? 1 : 0;
  if (opt.json) {
    const { internal, ...out } = data;
    console.log(JSON.stringify(out, null, 2));
    process.exit(code);
  }
  printSummary(data);
  if (opt.html) {
    fs.writeFileSync(opt.html, renderReport(data));
    console.log(`  Report written to ${opt.html}\n`);
    process.exit(code);
  }
  if (failUnder != null || data.score == null) process.exit(code);
  const { url } = await serve(data, { ...base, only });
  console.log(`  Report: ${url}\n  Press Ctrl+C to stop.\n`);
  if (!opt['no-open']) openBrowser(url);
} else if (command === 'fix') {
  if (!opt.yes) {
    if (!process.stdin.isTTY) die('Refusing to change files without confirmation. Add --yes to run without a prompt.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await rl.question(
      '\n  This replaces secrets in your AI chat history with [REDACTED].\n' +
        `  Every changed file is backed up first in ${pretty(r.state, r.home)}/backups.\n` +
        '  Close your AI tools first so no session is being written.\n\n  Continue? (y/N) ',
    );
    rl.close();
    if (!/^y(es)?$/i.test(a.trim())) process.exit(0);
  }
  const { files } = await checkLeaks(r, { only, onProgress });
  clearProgress();
  const out = redactHistory(r, files);
  console.log(`\n  Removed ${out.redacted} secret copies from ${out.files.length} files.`);
  if (out.kept) console.log(`  Left ${out.kept} in place because removing them would have broken the file.`);
  for (const s of out.skipped) console.log(`  Skipped ${pretty(s.file, r.home)}: ${s.reason}`);
  if (out.backupDir) {
    console.log(`\n  Backup: ${pretty(out.backupDir, r.home)}`);
    console.log('  The backup still contains the secrets. When your tools work fine, run: npx aicheckup purge');
  }
  console.log('  Rotate the keys too. Cleaning files does not make a leaked key safe.\n');
} else if (command === 'undo') {
  const out = undo(r);
  console.log(out.dir ? `\n  Restored ${out.restored} files from the last fix.\n` : '\n  No backup found.\n');
} else if (command === 'purge') {
  console.log(`\n  Deleted ${purge(r).removed} backup folder(s).\n`);
} else {
  die(`Unknown command "${command}".\n\n${HELP}`);
}
