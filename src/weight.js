// Weight: what is loaded into the context window before you type a word.
import fs from 'node:fs';
import path from 'node:path';
import { claudePlugins, estTokens, listDir, pretty, readText, walk } from './sources.js';

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));

function frontmatter(text, key) {
  const head = text?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const m = head?.match(new RegExp(`^${key}:\\s*(.*(?:\\r?\\n[ \\t]+.*)*)`, 'm'));
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}

// A skill, command or agent costs its name + description on every session start.
function listed(file, fallbackName) {
  const text = readText(file);
  if (text == null) return null;
  const name = frontmatter(text, 'name') || fallbackName;
  return { name, tokens: estTokens(name + frontmatter(text, 'description')) + 8 };
}

function claudeCatalog(r) {
  const skills = [];
  const agents = [];
  const from = (base, source) => {
    for (const e of listDir(path.join(base, 'skills'))) {
      if (!e.isDirectory()) continue;
      const s = listed(path.join(base, 'skills', e.name, 'SKILL.md'), e.name);
      if (s) skills.push({ ...s, source });
    }
    for (const f of walk(path.join(base, 'commands'), (n) => n.endsWith('.md'), 2)) {
      const s = listed(f, path.basename(f, '.md'));
      if (s) skills.push({ ...s, source });
    }
    for (const f of walk(path.join(base, 'agents'), (n) => n.endsWith('.md'), 1)) {
      const s = listed(f, path.basename(f, '.md'));
      if (s) agents.push({ ...s, source });
    }
  };
  from(r.claude, 'you');
  for (const p of claudePlugins(r)) from(p.dir, p.id);
  return { skills, agents };
}

// Real number from the tool's own log: tokens sent with the first request of each recent session.
function claudeMeasured(r) {
  const sessions = [];
  for (const e of listDir(path.join(r.claude, 'projects'))) {
    if (!e.isDirectory()) continue;
    for (const f of listDir(path.join(r.claude, 'projects', e.name))) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(r.claude, 'projects', e.name, f.name);
      try {
        sessions.push({ file, mtime: fs.statSync(file).mtimeMs });
      } catch {
        /* vanished */
      }
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const firsts = [];
  const buf = Buffer.allocUnsafe(6 << 20);
  for (const { file } of sessions.slice(0, 40)) {
    try {
      const fd = fs.openSync(file, 'r');
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      for (const line of buf.toString('utf8', 0, n).split('\n')) {
        if (!line.includes('"type":"assistant"') || !line.includes('"usage"')) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue; // cut at the buffer edge
        }
        const u = o.message?.usage;
        if (o.type !== 'assistant' || o.isSidechain || !u) continue;
        const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (total > 0) firsts.push(total);
        break;
      }
    } catch {
      /* unreadable session */
    }
  }
  if (firsts.length < 3) return null;
  firsts.sort((a, b) => a - b);
  return { median: firsts[firsts.length >> 1], min: firsts[0], max: firsts.at(-1), sessions: firsts.length };
}

export function checkWeight(r, { only } = {}) {
  const want = (t) => !only || only.includes(t);
  const findings = [];
  const map = []; // blocks for the context map

  if (want('claude')) {
    const rules = estTokens(readText(path.join(r.claude, 'CLAUDE.md')));
    const { skills, agents } = claudeCatalog(r);
    const skillTok = skills.reduce((a, s) => a + s.tokens, 0);
    const agentTok = agents.reduce((a, s) => a + s.tokens, 0);
    const measured = claudeMeasured(r);
    const known = rules + skillTok + agentTok;

    if (rules) map.push({ tool: 'claude', label: 'Your CLAUDE.md', tokens: rules });
    if (skillTok) map.push({ tool: 'claude', label: `${skills.length} skills and commands`, tokens: skillTok });
    if (agentTok) map.push({ tool: 'claude', label: `${agents.length} agents`, tokens: agentTok });
    if (measured && measured.median > known) {
      map.push({ tool: 'claude', label: 'System prompt, tools, MCP servers, first message', tokens: measured.median - known });
    }

    if (measured) {
      const m = measured.median;
      findings.push({
        id: 'weight-claude-start',
        category: 'weight',
        severity: m > 90000 ? 'high' : m > 50000 ? 'medium' : m > 30000 ? 'low' : 'info',
        tool: 'claude',
        title: `Claude Code sends about ${fmt(m)} tokens with your first message`,
        detail:
          `Middle value of your last ${measured.sessions} sessions (range ${fmt(measured.min)} to ${fmt(measured.max)}), read from Claude Code's own usage log. ` +
          'You pay for this on every new session, and it is space the model cannot use for your code.',
        items: [
          { label: 'Your CLAUDE.md', note: `~${fmt(rules)} tokens` },
          { label: `${skills.length} skills and commands`, note: `~${fmt(skillTok)} tokens` },
          { label: `${agents.length} agents`, note: `~${fmt(agentTok)} tokens` },
          { label: 'Everything else (system prompt, tools, MCP, first message)', note: `~${fmt(Math.max(0, m - known))} tokens` },
        ],
        fix: { type: 'manual', text: 'Turn off plugins, skills and MCP servers you do not use. Run /context in Claude Code to see the live split.' },
      });
    }

    const heavy = (list, what, limit) => {
      const total = list.reduce((a, s) => a + s.tokens, 0);
      if (total <= limit) return;
      const bySource = {};
      for (const s of list) bySource[s.source] = (bySource[s.source] || 0) + s.tokens;
      findings.push({
        id: `weight-claude-${what}`,
        category: 'weight',
        severity: total > limit * 3 ? 'medium' : 'low',
        tool: 'claude',
        title: `${list.length} ${what} cost about ${fmt(total)} tokens in every session`,
        detail: `Each one adds its name and description to the prompt even when you never use it.`,
        items: [
          ...Object.entries(bySource)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([src, t]) => ({ label: src === 'you' ? 'Your own' : `Plugin ${src}`, note: `~${fmt(t)} tokens` })),
          ...[...list]
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 6)
            .map((s) => ({ label: `Longest: ${s.name}`, note: `~${s.tokens} tokens` })),
        ],
        fix: { type: 'manual', text: `Remove or disable the ${what} you do not use, and shorten long descriptions.` },
      });
    };
    heavy(skills, 'skills and commands', 4000);
    heavy(agents, 'agents', 3000);
  }

  if (want('codex')) {
    const f = path.join(r.codex, 'AGENTS.md');
    const t = estTokens(readText(f));
    if (t) map.push({ tool: 'codex', label: 'Your AGENTS.md', tokens: t });
    const skills = listDir(path.join(r.codex, 'skills')).filter((e) => e.isDirectory()).length;
    if (skills > 40) {
      findings.push({
        id: 'weight-codex-skills',
        category: 'weight',
        severity: 'low',
        tool: 'codex',
        title: `${skills} Codex skills are listed in every session`,
        detail: 'Each skill adds its description to the prompt even when unused.',
        where: [pretty(path.join(r.codex, 'skills'), r.home)],
        fix: { type: 'manual', text: 'Delete the skills you do not use.' },
      });
    }
  }

  if (want('cursor')) {
    const files = walk(path.join(r.cursor, 'rules'), (n) => /\.mdc?$/.test(n), 2);
    const t = files.reduce((a, f) => a + estTokens(readText(f)), 0);
    if (t) map.push({ tool: 'cursor', label: `${files.length} Cursor rules`, tokens: t });
  }

  return { findings, map };
}
