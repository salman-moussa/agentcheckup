import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { hasBackups, purge, redactHistory, undo } from '../src/fix.js';
import { checkLeaks, scanFile } from '../src/leaks.js';
import { renderReport } from '../src/report.js';
import { unpinnedPackage } from '../src/risk.js';
import { scan } from '../src/scan.js';
import { findSecrets, redactText } from '../src/secrets.js';
import { serve } from '../src/server.js';
import { readTomlSections } from '../src/sources.js';
import { DB_URL, fake, makeHome, SECRETS } from '../demo/fixture.js';

const HOUR = 3600e3;
let home;
let r;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'acu-'));
  r = makeHome(home);
});
after(() => fs.rmSync(home, { recursive: true, force: true }));

const ids = (data) => data.findings.map((f) => f.id);
const rawSecrets = Object.values(SECRETS);

test('finds every supported key shape and never returns the raw value', () => {
  const text = `a ${SECRETS.github} b ${SECRETS.anthropic} c ${SECRETS.openai} d ${SECRETS.aws} e ${SECRETS.stripe} f ${DB_URL} g ${SECRETS.google}`;
  const hits = findSecrets(text);
  assert.deepEqual(hits.map((h) => h.type).sort(), ['anthropic', 'aws', 'dburl', 'github', 'google', 'openai', 'stripe']);
  for (const s of rawSecrets) assert.ok(!JSON.stringify(hits).includes(s), 'raw secret leaked into results');
});

test('ignores placeholders, doc examples and local dev databases', () => {
  const text = [
    'AKIAIOSFODNN7EXAMPLE',
    'ghp_' + 'x'.repeat(36),
    'sk-ant-your-key-here-your-key-here-your-key-here',
    'postgres://user:password@localhost:5432/dev',
    `postgres://dev:${SECRETS.dbPassword}@localhost/dev`,
    '-----BEGIN PRIVATE KEY-----',
  ].join('\n');
  assert.deepEqual(findSecrets(text), []);
});

test('redacts a private key block written with JSON-escaped newlines', () => {
  const body = fake('', 900, 9).replace(/(.{64})/g, '$1\\n');
  const line = JSON.stringify({ text: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----` });
  const out = redactText(line);
  assert.equal(out.count, 1);
  assert.deepEqual(JSON.parse(out.text), { text: '[REDACTED:privatekey]' });
});

test('redaction keeps the line valid JSON and removes the secret', () => {
  const line = JSON.stringify({ message: { content: `use ${SECRETS.github} and ${DB_URL}` } });
  const out = redactText(line);
  assert.equal(out.count, 2);
  assert.ok(!out.text.includes(SECRETS.github) && !out.text.includes(SECRETS.dbPassword));
  assert.match(JSON.parse(out.text).message.content, /app_user:\[REDACTED\]@db\.internal\.acme\.io/);
});

test('a secret that crosses a read-chunk edge is found exactly once', () => {
  const file = path.join(home, 'edge.jsonl');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, Buffer.alloc((8 << 20) - 20, 0x20));
  fs.writeSync(fd, SECRETS.github + ' tail');
  fs.closeSync(fd);
  const hits = scanFile(file, 'text');
  fs.rmSync(file);
  assert.equal(hits.size, 1);
  assert.equal([...hits.values()][0].count, 1);
});

test('unpinned MCP packages are flagged, pinned and local ones are not', () => {
  assert.equal(unpinnedPackage('npx', ['-y', 'some-mcp']), 'some-mcp');
  assert.equal(unpinnedPackage('npx', ['@scope/mcp@latest']), '@scope/mcp@latest');
  assert.equal(unpinnedPackage('cmd', ['/c', 'npx', '-y', '@scope/mcp']), '@scope/mcp');
  assert.equal(unpinnedPackage('uvx', ['tool==1.2.0']), null);
  assert.equal(unpinnedPackage('npx', ['-y', '@scope/mcp@1.4.2']), null);
  assert.equal(unpinnedPackage('npx', ['./local-server.js']), null);
  assert.equal(unpinnedPackage('node', ['server.js']), null);
});

test('reads the parts of config.toml it needs', () => {
  const t = readTomlSections('sandbox_mode = "danger-full-access"\n# c\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp@2.1.0"]\n');
  assert.equal(t[''].sandbox_mode, 'danger-full-access');
  assert.deepEqual(t['mcp_servers.docs'], { command: 'npx', args: ['-y', 'docs-mcp@2.1.0'] });
});

test('scan reports the problems planted in the fixture', async () => {
  const data = await scan({ home, env: {} });
  const expected = [
    'leaks-claude',
    'leaks-codex',
    'leaks-cursor',
    'leaks-mcp-config',
    'risk-claude-any-shell',
    'risk-claude-strong-shell',
    'risk-claude-hooks-network',
    'risk-codex-sandbox',
    'risk-mcp-unpinned',
    'risk-mcp-http',
    'weight-claude-start',
    'rules-duplicates',
    'rules-broken-import',
    'rules-dead-paths',
    'rules-drift',
  ];
  for (const id of expected) assert.ok(ids(data).includes(id), `missing finding ${id}`);

  const by = (id) => data.findings.find((f) => f.id === id);
  assert.match(by('leaks-claude').title, /^5 secrets/); // github, anthropic, db url, stripe, openai: each counted once
  assert.equal(by('risk-mcp-unpinned').items.length, 1); // docs-mcp@2.1.0 is pinned
  assert.equal(by('risk-claude-strong-shell').items.length, 3); // curl, rm, docker (npm test is fine)
  assert.equal(by('leaks-cursor').fix.type, 'manual');
  assert.match(by('weight-claude-start').title, /60k|59\.\dk|61k/);
  assert.equal(by('risk-codex-sandbox').severity, 'high');

  assert.ok(data.score >= 0 && data.score < 60, `score ${data.score}`);
  assert.equal(data.grade, data.score >= 50 ? 'Needs work' : 'At risk');

  const html = renderReport(data, { live: true, token: 't' });
  const json = JSON.stringify(data);
  for (const s of rawSecrets) {
    assert.ok(!json.includes(s), 'raw secret in scan result');
    assert.ok(!html.includes(s), 'raw secret in report');
  }
  assert.match(html, /data-fix="claude"/);
  assert.doesNotMatch(renderReport(data), /data-fix=/); // static export has no live buttons
});

test('--only limits the scan to the chosen tools', async () => {
  const data = await scan({ home, env: {}, only: ['codex'] });
  assert.ok(ids(data).includes('leaks-codex'));
  assert.ok(!ids(data).some((id) => id.includes('claude') || id.includes('cursor')));
});

test('an empty home gives no score instead of a perfect one', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'acu-empty-'));
  const data = await scan({ home: empty, env: {} });
  fs.rmSync(empty, { recursive: true, force: true });
  assert.equal(data.score, null);
  assert.match(renderReport(data), /No AI coding tools found/);
});

const dirty = async () => (await checkLeaks(r)).files;

test('worker threads give the same result as the inline scan', async () => {
  const strip = (d) => d.findings.filter((f) => f.category === 'leaks').map((f) => [f.id, f.title, f.items]);
  const [inline, parallel] = [await scan({ home, env: {}, workers: 0 }), await scan({ home, env: {}, workers: 3 })];
  assert.deepEqual(strip(parallel), strip(inline));
  assert.ok(strip(inline).length >= 3);
});

test('fix skips files that a running session is still writing', async () => {
  const out = redactHistory(r, await dirty()); // fixture files are seconds old
  assert.equal(out.files.length, 0);
  assert.ok(out.skipped.length >= 4);
  assert.equal(out.backupDir, null);
});

test('fix backs up, redacts, keeps JSON valid, leaves databases alone; undo restores', async () => {
  const db = path.join(r.cursorUser, 'globalStorage', 'state.vscdb');
  const dbBefore = fs.readFileSync(db);
  const session = path.join(r.claude, 'projects', '-work-shop-api', 'session-1.jsonl');
  const original = fs.readFileSync(session, 'utf8');
  const mtime = fs.statSync(session).mtimeMs;

  const out = redactHistory(r, await dirty(), { now: Date.now() + HOUR });
  assert.ok(out.redacted >= 7, `redacted ${out.redacted}`);
  assert.equal(out.skipped.length, 0);
  assert.ok(hasBackups(r));

  const cleaned = fs.readFileSync(session, 'utf8');
  assert.ok(!cleaned.includes(SECRETS.anthropic) && !cleaned.includes(SECRETS.dbPassword));
  for (const line of cleaned.trim().split('\n')) JSON.parse(line);
  assert.equal(cleaned.split('\n').length, original.split('\n').length);
  assert.equal(Math.round(fs.statSync(session).mtimeMs / 1000), Math.round(mtime / 1000));
  assert.deepEqual(fs.readFileSync(db), dbBefore);

  const after = await scan({ home, env: {} });
  assert.ok(!ids(after).includes('leaks-claude'));
  assert.ok(!ids(after).includes('leaks-codex'), 'plain and compressed Codex sessions are both cleaned');
  assert.ok(ids(after).includes('leaks-cursor'));

  assert.equal(undo(r).restored, out.files.length);
  assert.equal(fs.readFileSync(session, 'utf8'), original);
  assert.equal(hasBackups(r), false);

  redactHistory(r, await dirty(), { now: Date.now() + HOUR });
  assert.equal(purge(r).removed, 1);
  undo(r); // nothing to restore, must not throw
  makeHome(home); // put the fixture back for later tests
});

test('report server needs the token and a local Host header', async () => {
  const data = await scan({ home, env: {} });
  const { url, server } = await serve(data, { home, env: {} });
  try {
    const u = new URL(url);
    assert.equal((await fetch(`${u.origin}/`)).status, 403);
    assert.equal((await fetch(`${u.origin}/?t=wrong`)).status, 403);
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /aicheckup/);
    const bad = await fetch(`${u.origin}/fix?t=${u.searchParams.get('t')}`, { method: 'POST', body: JSON.stringify({ tool: 'nope' }) });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});
