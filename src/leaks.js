// Leaks: secrets sitting in plain text in AI chat history.
import fs from 'node:fs';
import os from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import zlib from 'node:zlib';
import { findSecrets, LABELS } from './secrets.js';
import { historyFiles, pretty, TOOLS } from './sources.js';

const CHUNK = 8 << 20;
const OVERLAP = 20 << 10; // longer than any single secret, so none is cut at a chunk edge
const RANGE = 32 << 20; // big files are split into ranges that workers scan in parallel
const INLINE_BELOW = 64 << 20; // not worth starting workers for less than this

/**
 * Count the secrets that START inside [start, end) of a file. Reading a little past each
 * edge keeps a secret whole, and the start rule means two ranges never count the same one.
 * Bytes are read as latin1 so text and database files work the same way (patterns are ASCII).
 * @returns {Map<string,{type:string,masked:string,count:number}>}
 */
export function scanRange(file, mode, start = 0, end = Infinity) {
  const hits = new Map();
  const add = (h) => {
    const cur = hits.get(h.fp);
    if (cur) cur.count++;
    else hits.set(h.fp, { type: h.type, masked: h.masked, count: 1 });
  };
  if (mode === 'zst') {
    if (!zlib.zstdDecompressSync) throw new Error('zstd needs Node 22.15+');
    for (const h of findSecrets(zlib.zstdDecompressSync(fs.readFileSync(file)).toString('latin1'))) add(h);
    return hits;
  }
  const fd = fs.openSync(file, 'r');
  try {
    end = Math.min(end, fs.fstatSync(fd).size);
    const buf = Buffer.allocUnsafe(CHUNK + OVERLAP);
    for (let pos = start; pos < end; pos += CHUNK) {
      const own = Math.min(CHUNK, end - pos);
      const n = fs.readSync(fd, buf, 0, own + OVERLAP, pos);
      for (const h of findSecrets(buf.toString('latin1', 0, n))) if (h.index < own) add(h);
    }
  } finally {
    fs.closeSync(fd);
  }
  return hits;
}

/** Scan one whole file. @returns {Map|null} null when the file cannot be read */
export function scanFile(file, mode) {
  try {
    return scanRange(file, mode);
  } catch {
    return null;
  }
}

// Worker side: this same file is started as a worker by scanAll below.
if (!isMainThread && workerData?.agentcheckup) {
  parentPort.on('message', (t) => {
    let hits = null;
    try {
      hits = [...scanRange(t.file, t.mode, t.start, t.end)];
    } catch {
      /* unreadable: reported as null */
    }
    parentPort.postMessage({ i: t.i, hits });
  });
}

/**
 * Scan many files, in parallel when there is enough data to make it worth it.
 * @returns {Promise<(Map|null)[]>} one entry per file, null when it could not be read
 */
export async function scanAll(files, { workers, onProgress } = {}) {
  const results = files.map(() => new Map());
  const tasks = [];
  let bytes = 0;
  files.forEach((f, i) => {
    let size;
    try {
      size = fs.statSync(f.file).size;
    } catch {
      results[i] = null;
      return;
    }
    bytes += size;
    if (f.mode === 'zst') tasks.push({ i, file: f.file, mode: f.mode });
    else for (let s = 0; s < size; s += RANGE) tasks.push({ i, file: f.file, mode: f.mode, start: s, end: s + RANGE });
  });

  let done = 0;
  const merge = (i, hits) => {
    onProgress?.(++done, tasks.length);
    if (!hits) return void (results[i] = null);
    if (!results[i]) return;
    for (const [fp, h] of hits) {
      const cur = results[i].get(fp);
      if (cur) cur.count += h.count;
      else results[i].set(fp, h);
    }
  };
  const inline = (t) => {
    try {
      merge(t.i, scanRange(t.file, t.mode, t.start, t.end));
    } catch {
      merge(t.i, null);
    }
  };

  const n = workers ?? (bytes < INLINE_BELOW ? 0 : Math.min(os.availableParallelism(), 8));
  let next = 0;
  const orphans = []; // tasks a crashed worker was holding
  if (n > 0 && tasks.length) {
    await new Promise((resolve) => {
      let alive = Math.min(n, tasks.length);
      const retire = () => --alive === 0 && resolve();
      for (let k = alive; k > 0; k--) {
        const w = new Worker(new URL(import.meta.url), { workerData: { agentcheckup: true } });
        let current = null;
        const feed = () => {
          current = tasks[next++] ?? null;
          if (current) w.postMessage(current);
          else w.terminate().then(retire);
        };
        w.on('message', (msg) => {
          merge(msg.i, msg.hits);
          feed();
        });
        w.once('error', () => {
          if (current) orphans.push(current);
          retire();
        });
        feed();
      }
    });
  }
  // Small jobs, plus anything left over if workers died.
  for (const t of orphans) inline(t);
  while (next < tasks.length) inline(tasks[next++]);
  return results;
}

/**
 * @returns {Promise<{findings:object[], files:{tool:string,file:string,mode:string,secrets:number}[], stats:object}>}
 */
export async function checkLeaks(r, { only, onProgress, workers } = {}) {
  const all = historyFiles(r, only);
  const scanned = await scanAll(all, { workers, onProgress });
  const perTool = {};
  const dirty = [];
  let unread = 0;
  let bytes = 0;

  all.forEach((f, i) => {
    const hits = scanned[i];
    if (!hits) return void unread++;
    try {
      bytes += fs.statSync(f.file).size;
    } catch {
      /* file vanished */
    }
    if (!hits.size) return;
    dirty.push({ ...f, secrets: hits.size });
    const t = (perTool[f.tool] ||= { secrets: new Map(), fixable: new Set(), locked: new Set() });
    (f.mode === 'binary' ? t.locked : t.fixable).add(f.file);
    for (const [fp, h] of hits) {
      const cur = t.secrets.get(fp) || { type: h.type, masked: h.masked, count: 0, fixable: false };
      cur.count += h.count;
      if (f.mode !== 'binary') cur.fixable = true;
      t.secrets.set(fp, cur);
    }
  });

  const findings = [];
  for (const [tool, t] of Object.entries(perTool)) {
    const secrets = [...t.secrets.values()].sort((a, b) => b.count - a.count);
    const byType = {};
    for (const s of secrets) byType[s.type] = (byType[s.type] || 0) + 1;
    const summary = Object.entries(byType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${n} × ${LABELS[type]}`)
      .join(', ');
    const fileCount = t.fixable.size + t.locked.size;
    findings.push({
      id: `leaks-${tool}`,
      category: 'leaks',
      severity: 'high',
      tool,
      title: `${secrets.length} secret${secrets.length === 1 ? '' : 's'} in ${TOOLS[tool]} chat history`,
      detail:
        `${summary}. Found in ${fileCount} file${fileCount === 1 ? '' : 's'}, saved as plain text on this disk. ` +
        'Anything that can read your home folder can read them. Rotate these keys first, then clean the history.',
      items: secrets.slice(0, 40).map((s) => ({
        label: `${LABELS[s.type]}  ${s.masked}`,
        note: `seen ${s.count}×${s.fixable ? '' : ' · database only'}`,
      })),
      where: [...t.fixable, ...t.locked].slice(0, 12).map((f) => pretty(f, r.home)),
      fix: t.fixable.size
        ? {
            type: 'redact',
            tool,
            text:
              `Replace the secrets in ${t.fixable.size} history file${t.fixable.size === 1 ? '' : 's'} with [REDACTED]. A backup is made first.` +
              (t.locked.size ? ` ${t.locked.size} database file${t.locked.size === 1 ? ' is' : 's are'} reported only and not edited.` : ''),
          }
        : {
            type: 'manual',
            text: `${TOOLS[tool]} keeps this history in a database it owns, so it is reported only. Rotate the keys, then delete the affected chats inside ${TOOLS[tool]}.`,
          },
    });
  }

  return { findings, files: dirty, stats: { filesScanned: all.length - unread, filesUnread: unread, bytesScanned: bytes } };
}
