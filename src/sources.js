// Where each AI tool keeps its files, and small helpers to read them safely.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOOLS = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

/** Resolve tool folders. Pass a fake `home` (and empty env) for tests and demos. */
export function locate(home = os.homedir(), env = process.env, platform = process.platform) {
  const cursorUser =
    platform === 'win32'
      ? path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Cursor', 'User')
        : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor', 'User');
  return {
    home,
    claude: env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    claudeJson: path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'),
    codex: env.CODEX_HOME || path.join(home, '.codex'),
    cursor: path.join(home, '.cursor'),
    cursorUser,
    state: path.join(home, '.agentcheckup'),
  };
}

export const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

export const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
};

export const listDir = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
};

/** Recursively list files under `dir` that pass `match`. Unreadable folders are skipped. */
export function walk(dir, match = () => true, depth = 6, out = []) {
  for (const e of listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) walk(p, match, depth - 1, out);
    } else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

/** Rough token estimate. ponytail: chars/4 heuristic, swap in a real tokenizer if exact numbers matter. */
export const estTokens = (text) => Math.ceil((text || '').length / 4);

/** Shorten a path for display: home becomes ~. */
export const pretty = (p, home) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p).replace(/\\/g, '/');

export function toolsPresent(r) {
  return {
    claude: exists(r.claude),
    codex: exists(r.codex),
    cursor: exists(r.cursor) || exists(r.cursorUser),
  };
}

/**
 * Chat history files per tool.
 * mode: 'text' (JSON lines, can be fixed), 'zst' (compressed JSON lines, can be fixed),
 * 'binary' (a database the tool owns: reported, never edited).
 */
export function historyFiles(r, only) {
  const want = (t) => !only || only.includes(t);
  const files = [];
  const add = (tool, file, mode) => files.push({ tool, file, mode });

  if (want('claude')) {
    for (const f of walk(path.join(r.claude, 'projects'), (n) => n.endsWith('.jsonl'))) add('claude', f, 'text');
    const h = path.join(r.claude, 'history.jsonl');
    if (exists(h)) add('claude', h, 'text');
  }
  if (want('codex')) {
    for (const d of ['sessions', 'archived_sessions']) {
      for (const f of walk(path.join(r.codex, d), (n) => /\.jsonl(\.zst)?$/.test(n))) {
        add('codex', f, f.endsWith('.zst') ? 'zst' : 'text');
      }
    }
    for (const n of ['history.jsonl', 'session_index.jsonl']) {
      const f = path.join(r.codex, n);
      if (exists(f)) add('codex', f, 'text');
    }
    for (const e of listDir(r.codex)) {
      if (e.isFile() && /\.sqlite(-wal)?$/.test(e.name)) add('codex', path.join(r.codex, e.name), 'binary');
    }
  }
  if (want('cursor')) {
    const db = (n) => /^state\.vscdb(\.backup)?$/.test(n);
    for (const f of walk(path.join(r.cursorUser, 'globalStorage'), db, 0)) add('cursor', f, 'binary');
    for (const f of walk(path.join(r.cursorUser, 'workspaceStorage'), db, 1)) add('cursor', f, 'binary');
  }
  return files;
}

/** Minimal TOML reader: sections and `key = value` lines only. ponytail: enough for Codex config.toml, not full TOML. */
export function readTomlSections(text) {
  const sections = { '': {} };
  let cur = '';
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = line.match(/^\[+\s*(.+?)\s*\]+$/);
    if (sec) {
      cur = sec[1];
      sections[cur] ||= {};
      continue;
    }
    const kv = line.match(/^("[^"]+"|'[^']+'|[\w.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (v.startsWith('[')) v = [...v.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    sections[cur][kv[1].replace(/^["']|["']$/g, '')] = v;
  }
  return sections;
}

/** Project folders the tools know about (that still exist on disk). */
export function knownProjects(r) {
  const set = new Set();
  for (const p of Object.keys(readJson(r.claudeJson)?.projects || {})) set.add(path.resolve(p));
  const toml = readTomlSections(readText(path.join(r.codex, 'config.toml')));
  for (const s of Object.keys(toml)) {
    const m = s.match(/^projects\.["'](.+)["']$/);
    if (m) set.add(path.resolve(m[1].replace(/\\\\/g, '\\')));
  }
  // Windows paths differ only by case between tools.
  const seen = new Map();
  for (const p of set) if (exists(p)) seen.set(process.platform === 'win32' ? p.toLowerCase() : p, p);
  return [...seen.values()].slice(0, 300);
}

/** Enabled Claude Code plugins with their install folders. */
export function claudePlugins(r) {
  const enabled = readJson(path.join(r.claude, 'settings.json'))?.enabledPlugins || {};
  const installed = readJson(path.join(r.claude, 'plugins', 'installed_plugins.json'))?.plugins || {};
  const out = [];
  for (const [id, entries] of Object.entries(installed)) {
    if (enabled[id] === false) continue;
    const dir = entries?.[0]?.installPath;
    if (dir && exists(dir)) out.push({ id, dir });
  }
  return out;
}
