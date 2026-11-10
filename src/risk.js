// Risk: what your tools are allowed to do without asking you.
import path from 'node:path';
import { findSecrets, LABELS } from './secrets.js';
import { claudePlugins, knownProjects, pretty, readJson, readText, readTomlSections } from './sources.js';

const ANY_SHELL = /^(?:Bash|PowerShell)(?:\(\s*:?\*\s*\))?$/i;
const STRONG_SHELL =
  /^(?:Bash|PowerShell)\(\s*(?:rm|sudo|curl|wget|bash|sh|zsh|python3?|py|node|npx|eval|ssh|scp|docker|kubectl|git push|chmod|dd|powershell|pwsh|iex|Invoke-Expression)\b[^)]*\*\s*\)$/i;
const NETWORK_HOOK = /\b(?:curl|wget|ncat|nc|Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b|\|\s*(?:ba|z)?sh\b|base64\s+(?:-d|--decode)/i;
const RUNNERS = /^(?:npx|bunx|uvx|pipx)(?:\.cmd|\.exe)?$/i;

/** Is this MCP server started with "download the newest version and run it"? */
export function unpinnedPackage(command, args = []) {
  const base = path.basename(String(command || ''));
  let rest = args.map(String);
  if (/^(?:pnpm|yarn)(?:\.cmd)?$/i.test(base) && rest[0] === 'dlx') rest = rest.slice(1);
  else if (/^(?:cmd|cmd\.exe)$/i.test(base)) {
    const i = rest.findIndex((a) => RUNNERS.test(a));
    if (i < 0) return null;
    rest = rest.slice(i + 1);
  } else if (!RUNNERS.test(base)) return null;
  const pkg = rest.find((a) => !a.startsWith('-'));
  if (!pkg || /^[./~]|^[A-Za-z]:\\/.test(pkg)) return null; // local path
  const at = pkg.lastIndexOf('@');
  const version = at > 0 ? pkg.slice(at + 1) : pkg.includes('==') ? pkg.split('==')[1] : '';
  return !version || version === 'latest' ? pkg : null;
}

function mcpServers(r, projects) {
  const out = [];
  const add = (tool, where, servers) => {
    for (const [name, s] of Object.entries(servers || {})) {
      if (s && typeof s === 'object') out.push({ tool, name, where, ...s });
    }
  };
  const cj = readJson(r.claudeJson);
  add('claude', r.claudeJson, cj?.mcpServers);
  for (const [p, v] of Object.entries(cj?.projects || {})) add('claude', `${r.claudeJson} (project ${p})`, v?.mcpServers);
  for (const pl of claudePlugins(r)) {
    const f = path.join(pl.dir, '.mcp.json');
    const j = readJson(f);
    add('claude', f, j?.mcpServers || j);
  }
  add('cursor', path.join(r.cursor, 'mcp.json'), readJson(path.join(r.cursor, 'mcp.json'))?.mcpServers);
  for (const p of projects) {
    add('claude', path.join(p, '.mcp.json'), readJson(path.join(p, '.mcp.json'))?.mcpServers);
    add('cursor', path.join(p, '.cursor', 'mcp.json'), readJson(path.join(p, '.cursor', 'mcp.json'))?.mcpServers);
  }
  const toml = readTomlSections(readText(path.join(r.codex, 'config.toml')));
  for (const [sec, v] of Object.entries(toml)) {
    const m = sec.match(/^mcp_servers\.([^.]+)$/);
    if (m) out.push({ tool: 'codex', name: m[1], where: path.join(r.codex, 'config.toml'), ...v, env: toml[`${sec}.env`] });
  }
  return out;
}

function hookCommands(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => hookCommands(n, out));
  else if (node && typeof node === 'object') {
    if (typeof node.command === 'string') out.push(node.command);
    for (const v of Object.values(node)) if (v && typeof v === 'object') hookCommands(v, out);
  }
  return out;
}

export function checkRisk(r, { only } = {}) {
  const want = (t) => !only || only.includes(t);
  const findings = [];
  const projects = knownProjects(r);
  const show = (p) => pretty(p, r.home);

  if (want('claude')) {
    // Permission rules: user settings, project settings, and per-project allowed tools.
    const sources = [
      path.join(r.claude, 'settings.json'),
      path.join(r.claude, 'settings.local.json'),
      ...projects.flatMap((p) => [path.join(p, '.claude', 'settings.json'), path.join(p, '.claude', 'settings.local.json')]),
    ].map((file) => ({ file, json: readJson(file) }));
    const allow = [];
    const bypass = [];
    for (const { file, json } of sources) {
      if (!json) continue;
      for (const rule of json.permissions?.allow || []) allow.push({ rule: String(rule), file });
      if (json.permissions?.defaultMode === 'bypassPermissions') bypass.push(file);
    }
    for (const [p, v] of Object.entries(readJson(r.claudeJson)?.projects || {})) {
      for (const rule of v?.allowedTools || []) allow.push({ rule: String(rule), file: `${r.claudeJson} (project ${p})` });
    }

    if (bypass.length) {
      findings.push({
        id: 'risk-claude-bypass',
        category: 'risk',
        severity: 'high',
        tool: 'claude',
        title: 'Claude Code is set to skip every permission prompt',
        detail: 'With defaultMode "bypassPermissions" the agent can run any command and edit any file without asking. One bad instruction in a web page or file is enough.',
        where: bypass.map(show),
        fix: { type: 'manual', text: 'Remove "defaultMode": "bypassPermissions" from permissions, or use it only inside a container.' },
      });
    }
    const any = allow.filter((a) => ANY_SHELL.test(a.rule.trim()));
    if (any.length) {
      findings.push({
        id: 'risk-claude-any-shell',
        category: 'risk',
        severity: 'high',
        tool: 'claude',
        title: 'Claude Code may run any shell command without asking',
        detail: 'An allow rule covers the whole shell. That includes deleting files, pushing code and sending data out.',
        items: any.slice(0, 20).map((a) => ({ label: a.rule, note: show(a.file) })),
        fix: { type: 'manual', text: 'Replace the rule with the exact commands you trust, for example Bash(npm test:*).' },
      });
    }
    const strong = allow.filter((a) => STRONG_SHELL.test(a.rule.trim()));
    if (strong.length) {
      findings.push({
        id: 'risk-claude-strong-shell',
        category: 'risk',
        severity: 'medium',
        tool: 'claude',
        title: `${strong.length} allow rule${strong.length === 1 ? ' lets' : 's let'} Claude Code run powerful commands without asking`,
        detail: 'Commands like rm, curl, ssh, docker or an interpreter can do almost anything once they are pre-approved with a wildcard.',
        items: strong.slice(0, 30).map((a) => ({ label: a.rule, note: show(a.file) })),
        fix: { type: 'manual', text: 'Narrow each rule to the exact command, or delete it and approve when asked.' },
      });
    }

    // Hooks run on their own, on every matching event.
    const hooks = [];
    for (const { file, json } of sources) for (const c of hookCommands(json?.hooks)) hooks.push({ c, file });
    for (const pl of claudePlugins(r)) {
      const f = path.join(pl.dir, 'hooks', 'hooks.json');
      for (const c of hookCommands(readJson(f))) hooks.push({ c, file: f, plugin: pl.id });
    }
    const net = hooks.filter((h) => NETWORK_HOOK.test(h.c));
    if (net.length) {
      findings.push({
        id: 'risk-claude-hooks-network',
        category: 'risk',
        severity: 'medium',
        tool: 'claude',
        title: `${net.length} hook${net.length === 1 ? '' : 's'} can reach the network or run downloaded code`,
        detail: 'Hooks run automatically with your full user rights and can see your prompts and tool output. Read these and make sure you trust them.',
        items: net.slice(0, 20).map((h) => ({ label: h.c.slice(0, 140), note: show(h.file) })),
        fix: { type: 'manual', text: 'Open each file, read the command, and remove any hook you did not write or do not need.' },
      });
    }
    const fromPlugins = hooks.filter((h) => h.plugin);
    if (fromPlugins.length) {
      const per = {};
      for (const h of fromPlugins) per[h.plugin] = (per[h.plugin] || 0) + 1;
      findings.push({
        id: 'risk-claude-plugin-hooks',
        category: 'risk',
        severity: 'low',
        tool: 'claude',
        title: `${Object.keys(per).length} plugin${Object.keys(per).length === 1 ? ' runs' : 's run'} ${fromPlugins.length} automatic hooks on your machine`,
        detail: 'A plugin update can change what these hooks do. Keep only plugins from authors you trust.',
        items: Object.entries(per).map(([id, n]) => ({ label: id, note: `${n} hook command${n === 1 ? '' : 's'}` })),
        fix: { type: 'manual', text: 'Disable plugins you do not use under enabledPlugins in ~/.claude/settings.json.' },
      });
    }
  }

  if (want('codex')) {
    const file = path.join(r.codex, 'config.toml');
    const top = readTomlSections(readText(file))[''];
    const open = top.sandbox_mode === 'danger-full-access';
    if (open) {
      const never = top.approval_policy === 'never';
      findings.push({
        id: 'risk-codex-sandbox',
        category: 'risk',
        severity: never ? 'high' : 'medium',
        tool: 'codex',
        title: never ? 'Codex runs with no sandbox and never asks for approval' : 'Codex runs with no sandbox',
        detail:
          'sandbox_mode "danger-full-access" lets commands touch any file and the network.' +
          (never ? ' With approval_policy "never" nothing stops a bad command.' : ''),
        where: [show(file)],
        fix: { type: 'manual', text: 'Set sandbox_mode = "workspace-write" and approval_policy = "on-request" in config.toml.' },
      });
    }
  }

  // MCP servers, all tools.
  const servers = mcpServers(r, projects).filter((s) => want(s.tool));
  const unpinned = servers.map((s) => ({ s, pkg: unpinnedPackage(s.command, s.args) })).filter((x) => x.pkg);
  if (unpinned.length) {
    findings.push({
      id: 'risk-mcp-unpinned',
      category: 'risk',
      severity: 'medium',
      title: `${unpinned.length} MCP server${unpinned.length === 1 ? ' downloads' : 's download'} and run the newest package on every start`,
      detail: 'No version is pinned. If that package or its author is ever compromised, the new code runs on your machine with your rights the next time the tool starts.',
      items: unpinned.slice(0, 30).map(({ s, pkg }) => ({ label: `${s.name}: ${pkg}`, note: show(s.where) })),
      fix: { type: 'manual', text: 'Pin a version you have checked, for example some-mcp@1.4.2 instead of some-mcp.' },
    });
  }
  const plain = servers.filter((s) => typeof s.url === 'string' && /^http:\/\/(?!localhost|127\.0\.0\.1|\[::1\])/i.test(s.url));
  if (plain.length) {
    findings.push({
      id: 'risk-mcp-http',
      category: 'risk',
      severity: 'medium',
      title: `${plain.length} MCP server${plain.length === 1 ? ' uses' : 's use'} plain http`,
      detail: 'Traffic to these servers, including any token, is not encrypted and can be read or changed on the network.',
      items: plain.map((s) => ({ label: `${s.name}: ${String(s.url).replace(/\?.*/, '')}`, note: show(s.where) })),
      fix: { type: 'manual', text: 'Use the https address of the server.' },
    });
  }
  const keyed = servers
    .map((s) => ({ s, hits: findSecrets(JSON.stringify([s.env, s.headers, s.args, s.url])) }))
    .filter((x) => x.hits.length);
  if (keyed.length) {
    findings.push({
      id: 'leaks-mcp-config',
      category: 'leaks',
      severity: 'medium',
      title: `${keyed.length} MCP server config${keyed.length === 1 ? ' holds' : 's hold'} a key in plain text`,
      detail: 'The key is written straight into a config file. Project config files often end up in git.',
      items: keyed.map(({ s, hits }) => ({ label: `${s.name}: ${LABELS[hits[0].type]} ${hits[0].masked}`, note: show(s.where) })),
      fix: { type: 'manual', text: 'Move the key to an environment variable and reference it from the config, for example ${GITHUB_TOKEN}.' },
    });
  }

  return { findings, stats: { projects: projects.length, mcpServers: servers.length } };
}
