// Fix: replace secrets in history files with [REDACTED]. Always backs up first.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { redactText } from './secrets.js';
import { listDir, readJson } from './sources.js';

const CHUNK = 8 << 20;
const ACTIVE_MS = 10 * 60 * 1000; // a file written in the last 10 minutes belongs to a running session

const isJson = (s) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};

/** Redact text line by line. A line that was valid JSON and would stop being valid is left untouched. */
function redactLines(text, tally) {
  return text
    .split('\n') // only \n: these files are JSON lines and may hold other line-break characters inside strings
    .map((line) => {
      const { text: out, count } = redactText(line);
      if (!count) return line;
      if (isJson(line) && !isJson(out)) {
        tally.kept += count;
        return line;
      }
      tally.redacted += count;
      return out;
    })
    .join('\n');
}

function rewrite(src, dst, mode, tally) {
  if (mode === 'zst') {
    const text = zlib.zstdDecompressSync(fs.readFileSync(src)).toString('utf8');
    fs.writeFileSync(dst, zlib.zstdCompressSync(Buffer.from(redactLines(text, tally), 'utf8')));
    return;
  }
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dst, 'w');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let carry = Buffer.alloc(0);
    let pos = 0;
    let n;
    while ((n = fs.readSync(inFd, buf, 0, CHUNK, pos)) > 0) {
      pos += n;
      const data = Buffer.concat([carry, buf.subarray(0, n)]);
      const cut = data.lastIndexOf(10); // split on a newline byte so no character is cut in half
      if (cut < 0) {
        carry = data;
        continue;
      }
      fs.writeSync(outFd, redactLines(data.toString('utf8', 0, cut + 1), tally));
      carry = data.subarray(cut + 1);
    }
    if (carry.length) fs.writeSync(outFd, redactLines(carry.toString('utf8'), tally));
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
}

/**
 * Redact secrets in the given history files (the `files` list from checkLeaks).
 * Databases are never edited.
 * @param {{file:string, mode:string}[]} files
 * @returns {{backupDir:string|null, files:{file:string,redacted:number}[], skipped:{file:string,reason:string}[], redacted:number, kept:number}}
 */
export function redactHistory(r, files, { now = Date.now() } = {}) {
  const result = { backupDir: null, files: [], skipped: [], redacted: 0, kept: 0 };
  const manifest = [];
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(r.state, 'backups', stamp);

  for (const f of files) {
    if (f.mode === 'binary') continue;
    let stat;
    try {
      stat = fs.statSync(f.file);
    } catch {
      continue;
    }
    if (now - stat.mtimeMs < ACTIVE_MS) {
      result.skipped.push({ file: f.file, reason: 'in use by a running session, run again later' });
      continue;
    }
    if (f.mode === 'zst' && !zlib.zstdCompressSync) {
      result.skipped.push({ file: f.file, reason: 'compressed file needs Node 22.15 or newer' });
      continue;
    }
    const backup = path.join(backupDir, `${String(manifest.length + 1).padStart(4, '0')}-${path.basename(f.file)}`);
    const tmp = f.file + '.agentcheckup.tmp';
    const tally = { redacted: 0, kept: 0 };
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(f.file, backup);
      rewrite(f.file, tmp, f.mode, tally);
      if (!tally.redacted) {
        // Nothing to change (already clean, or every hit had to stay): leave the file alone.
        fs.rmSync(tmp, { force: true });
        fs.rmSync(backup, { force: true });
        result.kept += tally.kept;
        continue;
      }
      fs.renameSync(tmp, f.file);
      fs.utimesSync(f.file, stat.atime, stat.mtime); // keep the session order in the tool's "resume" list
      manifest.push({ original: f.file, backup });
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
      result.files.push({ file: f.file, redacted: tally.redacted });
      result.redacted += tally.redacted;
      result.kept += tally.kept;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      result.skipped.push({ file: f.file, reason: e.code === 'EBUSY' || e.code === 'EPERM' ? 'file is locked by another program' : e.message });
    }
  }
  if (manifest.length) result.backupDir = backupDir;
  return result;
}

const backupRuns = (r) =>
  listDir(path.join(r.state, 'backups'))
    .filter((e) => e.isDirectory())
    .map((e) => path.join(r.state, 'backups', e.name))
    .sort();

/** Put back the files from the most recent fix. */
export function undo(r) {
  const dir = backupRuns(r).at(-1);
  const manifest = dir && readJson(path.join(dir, 'manifest.json'));
  if (!manifest) return { restored: 0, dir: null };
  let restored = 0;
  for (const { original, backup } of manifest) {
    try {
      fs.copyFileSync(backup, original);
      restored++;
    } catch {
      /* original folder is gone */
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { restored, dir };
}

/** Delete all backups. They still contain the secrets, so do this once your tools work fine. */
export function purge(r) {
  const runs = backupRuns(r);
  fs.rmSync(path.join(r.state, 'backups'), { recursive: true, force: true });
  return { removed: runs.length };
}

export const hasBackups = (r) => backupRuns(r).length > 0;
