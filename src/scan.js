// Runs every check and turns the findings into one score.
import { checkLeaks } from './leaks.js';
import { checkRisk } from './risk.js';
import { checkRules } from './rules.js';
import { locate, TOOLS, toolsPresent } from './sources.js';
import { checkWeight } from './weight.js';

export const VERSION = '0.1.0';

export const CATEGORIES = [
  { key: 'leaks', label: 'Leaks', blurb: 'Secrets saved in chat history and configs', weight: 0.35 },
  { key: 'risk', label: 'Risk', blurb: 'What agents may do without asking', weight: 0.3 },
  { key: 'weight', label: 'Weight', blurb: 'Tokens loaded before you type', weight: 0.2 },
  { key: 'rules', label: 'Rules', blurb: 'Health of your instruction files', weight: 0.15 },
];

const COST = { high: 30, medium: 12, low: 4, info: 0 };
const ORDER = { high: 0, medium: 1, low: 2, info: 3 };

export const grade = (score) => (score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Needs work' : 'At risk');

/**
 * @param {{home?:string, env?:object, only?:string[], workers?:number, onProgress?:(done:number,total:number)=>void}} [opts]
 */
export async function scan({ home, env, only, workers, onProgress } = {}) {
  const r = locate(home, env);
  const present = toolsPresent(r);
  const active = Object.keys(TOOLS).filter((t) => present[t] && (!only || only.includes(t)));
  const opts = { only: active, onProgress, workers };

  const leaks = await checkLeaks(r, opts);
  const risk = checkRisk(r, opts);
  const weight = checkWeight(r, opts);
  const rules = checkRules(r, opts);

  const findings = [...leaks.findings, ...risk.findings, ...weight.findings, ...rules.findings].sort(
    (a, b) => ORDER[a.severity] - ORDER[b.severity],
  );

  const categories = CATEGORIES.map((c) => {
    const mine = findings.filter((f) => f.category === c.key);
    const counts = { high: 0, medium: 0, low: 0, info: 0 };
    for (const f of mine) counts[f.severity]++;
    const score = Math.max(0, 100 - mine.reduce((a, f) => a + COST[f.severity], 0));
    return { ...c, score, counts };
  });
  const score = active.length ? Math.round(categories.reduce((a, c) => a + c.score * c.weight, 0)) : null;

  return {
    name: 'aicheckup',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    tools: Object.fromEntries(Object.entries(TOOLS).map(([k, label]) => [k, { label, found: present[k], scanned: active.includes(k) }])),
    score,
    grade: score == null ? null : grade(score),
    categories,
    findings,
    contextMap: weight.map,
    stats: { ...leaks.stats, ...risk.stats, ...rules.stats },
    // Local paths for the fix action. Left out of --json output.
    internal: { roots: r, dirty: leaks.files },
  };
}
