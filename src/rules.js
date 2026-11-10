// Rules: the instruction files your agents read (CLAUDE.md, AGENTS.md, Cursor rules).
import path from 'node:path';
import { estTokens, exists, knownProjects, pretty, readText, walk } from './sources.js';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function ruleFiles(r, only) {
  const want = (t) => !only || only.includes(t);
  const files = [];
  const add = (tool, file, project) => {
    const text = readText(file);
    if (text && text.trim()) files.push({ tool, file, project, text });
  };
  if (want('claude')) add('claude', path.join(r.claude, 'CLAUDE.md'));
  if (want('codex')) add('codex', path.join(r.codex, 'AGENTS.md'));
  if (want('cursor')) for (const f of walk(path.join(r.cursor, 'rules'), (n) => /\.mdc?$/.test(n), 2)) add('cursor', f);
  for (const p of knownProjects(r)) {
    if (want('claude')) {
      add('claude', path.join(p, 'CLAUDE.md'), p);
      add('claude', path.join(p, '.claude', 'CLAUDE.md'), p);
    }
    if (want('codex')) add('codex', path.join(p, 'AGENTS.md'), p);
    if (want('cursor')) {
      add('cursor', path.join(p, '.cursorrules'), p);
      for (const f of walk(path.join(p, '.cursor', 'rules'), (n) => /\.mdc?$/.test(n), 2)) add('cursor', f, p);
    }
  }
  return files;
}

export function checkRules(r, { only } = {}) {
  const files = ruleFiles(r, only);
  const show = (p) => pretty(p, r.home);
  const findings = [];
  const group = (id, severity, title, detail, fix, items) => {
    if (items.length) findings.push({ id, category: 'rules', severity, title: title(items.length), detail, items: items.slice(0, 25), fix: { type: 'manual', text: fix } });
  };

  // 1. Too long: every line is paid for on every request and long files get skimmed.
  const long = files.map((f) => ({ f, t: estTokens(f.text) })).filter((x) => x.t > 3000);
  group(
    'rules-long',
    long.some((x) => x.t > 6000) ? 'medium' : 'low',
    (n) => `${n} rule file${n === 1 ? ' is' : 's are'} very long`,
    'Long instruction files cost tokens on every request, and models follow them less reliably as they grow.',
    'Keep the rules that change behaviour. Move reference material into separate docs the agent can open when needed.',
    long.sort((a, b) => b.t - a.t).map(({ f, t }) => ({ label: show(f.file), note: `~${t.toLocaleString('en-US')} tokens` })),
  );

  // 2. The same rule written more than once.
  const dupes = [];
  for (const f of files) {
    const seen = new Map();
    for (const line of f.text.split(/\r?\n/)) {
      const k = norm(line);
      if (k.length >= 40) seen.set(k, (seen.get(k) || 0) + 1);
    }
    const n = [...seen.values()].filter((c) => c > 1).length;
    if (n) dupes.push({ label: show(f.file), note: `${n} repeated line${n === 1 ? '' : 's'}` });
  }
  group(
    'rules-duplicates',
    'low',
    (n) => `${n} rule file${n === 1 ? ' repeats' : 's repeat'} the same lines`,
    'Repeated rules waste tokens and drift apart when only one copy is edited.',
    'Keep one copy of each rule.',
    dupes,
  );

  // 3. @imports that point to a missing file (CLAUDE.md syntax).
  const broken = [];
  for (const f of files.filter((x) => x.tool === 'claude')) {
    const prose = f.text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of prose.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.[A-Za-z]{1,5})(?=\s|$)/g)) {
      const ref = m[1];
      const target = ref.startsWith('~/') ? path.join(r.home, ref.slice(2)) : path.resolve(path.dirname(f.file), ref);
      if (!exists(target)) broken.push({ label: `@${ref}`, note: show(f.file) });
    }
  }
  group(
    'rules-broken-import',
    'medium',
    (n) => `${n} import${n === 1 ? '' : 's'} in CLAUDE.md point${n === 1 ? 's' : ''} to a missing file`,
    'The agent silently gets nothing for a missing import, so the rules you think are loaded are not.',
    'Fix the path or remove the import line.',
    broken,
  );

  // 4. File paths named in project rules that no longer exist.
  const dead = [];
  for (const f of files.filter((x) => x.project)) {
    const missing = new Set();
    for (const m of f.text.matchAll(/`([\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,5})`/g)) {
      if (!exists(path.join(f.project, m[1])) && !exists(path.resolve(path.dirname(f.file), m[1]))) missing.add(m[1]);
    }
    if (missing.size) dead.push({ label: show(f.file), note: [...missing].slice(0, 4).join(', ') + (missing.size > 4 ? ` +${missing.size - 4} more` : '') });
  }
  group(
    'rules-dead-paths',
    'low',
    (n) => `${n} rule file${n === 1 ? ' names' : 's name'} files that no longer exist`,
    'Stale paths send the agent looking for code that moved or was deleted.',
    'Update or remove the stale paths.',
    dead,
  );

  // 5. A project with both CLAUDE.md and AGENTS.md that are not linked: the two agents get different rules.
  const drift = [];
  const byProject = new Map();
  for (const f of files.filter((x) => x.project)) {
    const base = path.basename(f.file);
    if (base !== 'CLAUDE.md' && base !== 'AGENTS.md') continue;
    const cur = byProject.get(f.project) || {};
    cur[base] ||= f;
    byProject.set(f.project, cur);
  }
  for (const [project, pair] of byProject) {
    const c = pair['CLAUDE.md'];
    const a = pair['AGENTS.md'];
    if (!c || !a || norm(c.text) === norm(a.text)) continue;
    if (/AGENTS\.md/.test(c.text) || /CLAUDE\.md/.test(a.text)) continue; // one imports the other
    drift.push({ label: show(project), note: 'CLAUDE.md and AGENTS.md differ' });
  }
  group(
    'rules-drift',
    'low',
    (n) => `${n} project${n === 1 ? ' gives' : 's give'} Claude Code and Codex different rules`,
    'Both files exist and neither refers to the other, so each agent works from its own copy.',
    'Keep the rules in AGENTS.md and make CLAUDE.md a one-line import: @AGENTS.md',
    drift,
  );

  // 6. Shouting: when everything is IMPORTANT, nothing is.
  const loud = [];
  for (const f of files) {
    const n = (f.text.match(/\b(?:NEVER|ALWAYS|MUST|IMPORTANT|CRITICAL)\b/g) || []).length;
    if (n > 15) loud.push({ label: show(f.file), note: `${n} words in capitals` });
  }
  group(
    'rules-shouting',
    'low',
    (n) => `${n} rule file${n === 1 ? ' leans' : 's lean'} on capital-letter warnings`,
    'When many rules are marked NEVER, MUST or IMPORTANT, the model cannot tell which ones truly matter.',
    'Keep capitals for the two or three rules that must never be broken.',
    loud,
  );

  return { findings, stats: { ruleFiles: files.length } };
}
