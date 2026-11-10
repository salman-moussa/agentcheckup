// Builds the report as one self-contained HTML page (no external requests).
import { TOOLS } from './sources.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const tone = (score) => (score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad');
const SEV = { high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

const CSS = `
:root{--bg:#f5f4f0;--surface:#fff;--ink:#191c1f;--muted:#5d6570;--line:#e2e0d9;--soft:#efede7;
--accent:#0f5c4c;--good:#1b7a57;--warn:#a86400;--bad:#b3261e;--info:#5d6570;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--surface:#1a1d20;--ink:#e9e7e2;--muted:#9aa2ac;--line:#2b2f34;--soft:#22262a;
--accent:#62c4a8;--good:#5fc79d;--warn:#e0a44a;--bad:#f0857c;--info:#9aa2ac}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1040px;margin:0 auto;padding:0 20px 72px}
header.top{display:flex;flex-wrap:wrap;gap:6px 20px;align-items:baseline;justify-content:space-between;padding:22px 0 18px;border-bottom:1px solid var(--line)}
.brand{font-weight:650;letter-spacing:-.01em;font-size:16px}
.brand span{color:var(--muted);font-weight:400}
.meta{color:var(--muted);font-size:13px}
h1,h2,h3{margin:0;letter-spacing:-.015em}
.hero{display:grid;grid-template-columns:auto 1fr;gap:36px;align-items:center;padding:40px 0 32px}
.ring{position:relative;width:176px;height:176px;flex:none}
.ring svg{width:100%;height:100%;transform:rotate(-90deg)}
.ring circle{fill:none;stroke-width:10}
.ring .track{stroke:var(--soft)}
.ring .val{stroke-linecap:round}
.ring .num{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.ring .num b{font-size:54px;line-height:1;font-weight:650;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.ring .num small{color:var(--muted);font-size:13px;margin-top:4px}
.hero h1{font-size:30px;line-height:1.2;font-weight:650;max-width:22ch}
.hero p{margin:10px 0 0;color:var(--muted);max-width:56ch}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.chip{font-size:12.5px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;color:var(--muted);background:var(--surface)}
.chip.on{color:var(--ink)}
.chip.on::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--good);margin-right:7px;vertical-align:1px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
button{font:inherit;font-size:14px;font-weight:550;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
button:hover{border-color:var(--muted)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.cats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.cat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px 16px 14px;text-decoration:none;color:inherit;display:block}
.cat:hover{border-color:var(--muted)}
.cat .row{display:flex;justify-content:space-between;align-items:baseline}
.cat .label{font-weight:600}
.cat .score{font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.bar{height:4px;border-radius:2px;background:var(--soft);margin:10px 0 10px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:2px}
.cat .blurb,.cat .counts{font-size:12.5px;color:var(--muted)}
.cat .counts{margin-top:6px;color:var(--ink)}
.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.bg-good{background:var(--good)}.bg-warn{background:var(--warn)}.bg-bad{background:var(--bad)}
.st-good{stroke:var(--good)}.st-warn{stroke:var(--warn)}.st-bad{stroke:var(--bad)}
section{margin-top:44px}
section>h2{font-size:19px;font-weight:650;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px}
section>h2 small{font-size:13px;font-weight:400;color:var(--muted)}
.lede{color:var(--muted);margin:4px 0 16px;max-width:70ch}
.map{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:16px}
.map h3{font-size:13px;font-weight:600;color:var(--muted);margin:0 0 8px;display:flex;justify-content:space-between}
.map .tool+.tool{margin-top:16px}
.blocks{display:flex;gap:3px;min-height:74px}
.block{min-width:44px;border-radius:6px;padding:8px 10px;background:var(--soft);overflow:hidden;display:flex;flex-direction:column;justify-content:space-between}
.block b{font-size:15px;font-variant-numeric:tabular-nums}
.block span{font-size:12px;color:var(--muted);line-height:1.3}
.block:nth-child(1){background:color-mix(in srgb,var(--accent) 22%,var(--surface))}
.block:nth-child(2){background:color-mix(in srgb,var(--accent) 14%,var(--surface))}
.block:nth-child(3){background:color-mix(in srgb,var(--accent) 8%,var(--surface))}
.finding{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin-top:10px}
.finding>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center;padding:14px 16px;border-radius:12px}
.finding>summary::-webkit-details-marker{display:none}
.finding>summary::after{content:"";width:7px;height:7px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(45deg);margin:0 4px 3px 0;transition:transform .15s}
.finding[open]>summary::after{transform:rotate(-135deg);margin-bottom:-3px}
.sev{font-size:11.5px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;padding:2px 8px;border-radius:5px;min-width:64px;text-align:center}
.sev.high{color:var(--bad);background:color-mix(in srgb,var(--bad) 12%,transparent)}
.sev.medium{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}
.sev.low,.sev.info{color:var(--info);background:var(--soft)}
.finding .title{font-weight:600;overflow-wrap:anywhere}
.finding .title small{font-weight:400;color:var(--muted);margin-left:8px;white-space:nowrap}
.body{padding:2px 16px 16px;border-top:1px solid var(--line)}
.body p{margin:12px 0 0;max-width:76ch}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13.5px}
td{padding:6px 0;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
td:first-child{font-family:var(--mono);font-size:12.5px;padding-right:16px}
td:last-child{color:var(--muted);text-align:right;width:38%}
.where{margin-top:12px;font:12.5px/1.6 var(--mono);color:var(--muted);overflow-wrap:anywhere}
.fix{margin-top:14px;padding:12px 14px;border-radius:8px;background:var(--soft);display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
.fix div{flex:1 1 320px}
.fix b{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-bottom:2px}
.fix code,.foot code{font:12.5px var(--mono);background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.note{margin-top:12px;font-size:13.5px}
.empty{background:var(--surface);border:1px dashed var(--line);border-radius:12px;padding:16px;color:var(--muted)}
.foot{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;display:grid;gap:6px}
@media (max-width:760px){
.hero{grid-template-columns:1fr;gap:22px;padding:28px 0 24px}.ring{width:148px;height:148px}.ring .num b{font-size:46px}
.hero h1{font-size:24px}.cats{grid-template-columns:repeat(2,1fr)}
.blocks{flex-direction:column;min-height:0}.block{flex:none!important;flex-direction:row;align-items:baseline;justify-content:flex-start;gap:10px;min-height:0}
.finding>summary{grid-template-columns:1fr auto;row-gap:8px}.sev{justify-self:start;grid-column:1/-1}
td{display:block;border-top:0;padding:0}td:first-child{border-top:1px solid var(--line);padding-top:7px}td:last-child{text-align:left;width:auto;padding-bottom:7px}
.finding .title small{display:block;margin:2px 0 0}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;

function headline(data) {
  const high = data.findings.filter((f) => f.severity === 'high').length;
  const medium = data.findings.filter((f) => f.severity === 'medium').length;
  if (high) return `${high} serious problem${high === 1 ? '' : 's'} to fix first`;
  if (medium) return `No serious problems. ${medium} thing${medium === 1 ? '' : 's'} worth tightening`;
  return 'Your AI setup is in good shape';
}

function findingHtml(f, live) {
  const items = (f.items || []).map((i) => `<tr><td>${esc(i.label)}</td><td>${esc(i.note)}</td></tr>`).join('');
  const where = (f.where || []).map(esc).join('<br>');
  let fix = '';
  if (f.fix?.type === 'redact') {
    fix = live
      ? `<div class="fix"><div><b>Fix</b>${esc(f.fix.text)}</div><button class="primary" data-fix="${esc(f.fix.tool)}">Clean history</button></div><div class="note" data-result hidden></div>`
      : `<div class="fix"><div><b>Fix</b>${esc(f.fix.text)} Run <code>npx agentcheckup fix</code></div></div>`;
  } else if (f.fix) {
    fix = `<div class="fix"><div><b>How to fix</b>${esc(f.fix.text)}</div></div>`;
  }
  return `<details class="finding"${f.severity === 'high' ? ' open' : ''}>
<summary><span class="sev ${f.severity}">${SEV[f.severity]}</span><span class="title">${esc(f.title)}${f.tool ? `<small>${esc(TOOLS[f.tool])}</small>` : ''}</span></summary>
<div class="body"><p>${esc(f.detail)}</p>${items ? `<table>${items}</table>` : ''}${where ? `<div class="where">${where}</div>` : ''}${fix}</div>
</details>`;
}

function mapHtml(data) {
  if (!data.contextMap.length) return '';
  const tools = [...new Set(data.contextMap.map((b) => b.tool))];
  const rows = tools
    .map((t) => {
      const blocks = data.contextMap.filter((b) => b.tool === t).sort((a, b) => b.tokens - a.tokens);
      const total = blocks.reduce((a, b) => a + b.tokens, 0);
      return `<div class="tool"><h3><span>${esc(TOOLS[t])}</span><span>~${fmt(total)} tokens</span></h3><div class="blocks">${blocks
        .map((b) => `<div class="block" style="flex:${Math.round(Math.max(b.tokens, total * 0.06))} 1 0"><b>${fmt(b.tokens)}</b><span>${esc(b.label)}</span></div>`)
        .join('')}</div></div>`;
    })
    .join('');
  return `<section><h2>Context map <small>tokens used before you type</small></h2>
<p class="lede">Block width follows token count. Sizes of your own files are estimates (4 characters per token). The Claude Code total is measured from its usage log.</p>
<div class="map">${rows}</div></section>`;
}

// Runs in the browser: this function is inlined into the page with toString().
function client() {
  var token = document.body.dataset.token;
  document.querySelectorAll('[data-fix]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var ok = confirm('Replace the secrets in these history files with [REDACTED]?\n\nA backup of every changed file is saved first in ~/.agentcheckup/backups.\nYou can restore it with: npx agentcheckup undo\n\nRotate the keys as well. Cleaning the files does not make a leaked key safe.');
      if (!ok) return;
      var out = btn.closest('.body').querySelector('[data-result]');
      btn.disabled = true;
      btn.textContent = 'Cleaning…';
      fetch('/fix?t=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tool: btn.dataset.fix }) })
        .then(function (r) { return r.json(); })
        .then(function (r) {
          out.hidden = false;
          if (r.error) { out.textContent = 'Could not clean: ' + r.error; btn.disabled = false; btn.textContent = 'Clean history'; return; }
          out.textContent = 'Removed ' + r.redacted + ' secret copies from ' + r.files + ' files.' +
            (r.skipped ? ' Skipped ' + r.skipped + ' files that were written in the last 10 minutes or are locked. Close your AI tools and try again.' : '') + ' Reloading…';
          setTimeout(function () { location.reload(); }, r.skipped ? 6000 : 1600);
        })
        .catch(function () { out.hidden = false; out.textContent = 'The local server has stopped. Run npx agentcheckup again.'; });
    });
  });

  var share = document.getElementById('share');
  if (share) share.addEventListener('click', function () {
    var d = JSON.parse(document.getElementById('card-data').textContent);
    var colour = function (s) { return s >= 85 ? '#5fc79d' : s >= 60 ? '#e0a44a' : '#f0857c'; };
    var c = 2 * Math.PI * 130;
    var cats = d.categories.map(function (cat, i) {
      var y = 214 + i * 84;
      return '<text x="560" y="' + y + '" font-size="28" fill="#9aa2ac">' + cat.label + '</text>' +
        '<text x="1100" y="' + y + '" font-size="34" font-weight="600" fill="#e9e7e2" text-anchor="end">' + cat.score + '</text>' +
        '<rect x="560" y="' + (y + 16) + '" width="540" height="6" rx="3" fill="#2b2f34"/>' +
        '<rect x="560" y="' + (y + 16) + '" width="' + 5.4 * cat.score + '" height="6" rx="3" fill="' + colour(cat.score) + '"/>';
    }).join('');
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" font-family="Segoe UI,system-ui,Helvetica,Arial,sans-serif">' +
      '<rect width="1200" height="630" fill="#111315"/>' +
      '<text x="100" y="96" font-size="30" font-weight="600" fill="#e9e7e2">agentcheckup</text>' +
      '<text x="1100" y="96" font-size="24" fill="#9aa2ac" text-anchor="end">My AI coding setup</text>' +
      '<circle cx="270" cy="350" r="130" fill="none" stroke="#22262a" stroke-width="18"/>' +
      '<circle cx="270" cy="350" r="130" fill="none" stroke="' + colour(d.score) + '" stroke-width="18" stroke-linecap="round" stroke-dasharray="' + c * d.score / 100 + ' ' + c + '" transform="rotate(-90 270 350)"/>' +
      '<text x="270" y="378" font-size="104" font-weight="600" fill="#e9e7e2" text-anchor="middle">' + d.score + '</text>' +
      '<text x="270" y="424" font-size="26" fill="#9aa2ac" text-anchor="middle">' + d.grade + '</text>' + cats +
      '<text x="100" y="578" font-size="24" fill="#9aa2ac">Check yours:  npx agentcheckup</text></svg>';
    var img = new Image();
    img.onload = function () {
      var cv = document.createElement('canvas');
      cv.width = 1200; cv.height = 630;
      cv.getContext('2d').drawImage(img, 0, 0);
      var a = document.createElement('a');
      a.download = 'agentcheckup-score.png';
      a.href = cv.toDataURL('image/png');
      a.click();
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

/**
 * @param {object} data result of scan()
 * @param {{live?:boolean, token?:string, hasBackups?:boolean}} [opts] live = served by the local server, so Fix buttons work
 */
export function renderReport(data, { live = false, token = '', hasBackups = false } = {}) {
  const toolChips = Object.values(data.tools)
    .map((t) => `<span class="chip${t.scanned ? ' on' : ''}">${esc(t.label)}${t.scanned ? '' : t.found ? ' · skipped' : ' · not found'}</span>`)
    .join('');
  const when = new Date(data.generatedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  if (data.score == null) {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>agentcheckup</title><style>${CSS}</style>
<body><div class="wrap"><header class="top"><div class="brand">agentcheckup</div></header>
<div class="hero" style="grid-template-columns:1fr"><div><h1>No AI coding tools found</h1><p>Looked for Claude Code, Codex and Cursor in your home folder and found none of them.</p><div class="chips">${toolChips}</div></div></div></div></body></html>`;
  }

  const b = data.stats.bytesScanned;
  const size = b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
  const t = tone(data.score);
  const C = 2 * Math.PI * 52;
  const cats = data.categories
    .map((c) => {
      const parts = ['high', 'medium', 'low'].filter((s) => c.counts[s]).map((s) => `${c.counts[s]} ${s}`);
      return `<a class="cat" href="#${c.key}"><div class="row"><span class="label">${c.label}</span><span class="score ${tone(c.score)}">${c.score}</span></div>
<div class="bar"><i class="bg-${tone(c.score)}" style="width:${c.score}%"></i></div><div class="blurb">${esc(c.blurb)}</div><div class="counts">${parts.join(' · ') || 'No problems found'}</div></a>`;
    })
    .join('');
  const sections = data.categories
    .map((c) => {
      const list = data.findings.filter((f) => f.category === c.key);
      return `<section id="${c.key}"><h2>${c.label} <small>${esc(c.blurb)}</small></h2>${
        list.length ? list.map((f) => findingHtml(f, live)).join('') : '<div class="empty" style="margin-top:12px">Nothing found here.</div>'
      }</section>`;
    })
    .join('');
  const card = JSON.stringify({ score: data.score, grade: data.grade, categories: data.categories.map((c) => ({ label: c.label, score: c.score })) }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentcheckup · ${data.score}/100</title><style>${CSS}</style></head>
<body data-token="${esc(token)}"><div class="wrap">
<header class="top"><div class="brand">agentcheckup <span>v${esc(data.version)}</span></div><div class="meta">Scanned on this machine · ${esc(when)} · nothing was sent anywhere</div></header>
<div class="hero">
<div class="ring" role="img" aria-label="Score ${data.score} out of 100"><svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/><circle class="val st-${t}" cx="60" cy="60" r="52" stroke-dasharray="${((C * data.score) / 100).toFixed(1)} ${C.toFixed(1)}"/></svg><div class="num"><b>${data.score}</b><small>${esc(data.grade)}</small></div></div>
<div><h1>${esc(headline(data))}</h1>
<p>Checked ${data.stats.filesScanned.toLocaleString('en-US')} history files (${size}), ${data.stats.ruleFiles} rule files, ${data.stats.mcpServers} MCP servers and ${data.stats.projects} project${data.stats.projects === 1 ? '' : 's'}.</p>
<div class="chips">${toolChips}</div>
<div class="actions"><button id="share">Download score card</button></div></div>
</div>
<div class="cats">${cats}</div>
${mapHtml(data)}
${sections}
<div class="foot">
<div>The score card image holds only the five numbers above. No paths, keys or names.</div>
${hasBackups ? '<div>Backups from an earlier clean still exist and still contain the secrets. Restore with <code>npx agentcheckup undo</code> or delete with <code>npx agentcheckup purge</code>.</div>' : ''}
<div>Detection covers keys with a fixed format. Passwords written as plain words are not detected.</div>
</div>
</div>
<script type="application/json" id="card-data">${card}</script>
<script>(${client.toString()})();</script>
</body></html>`;
}
