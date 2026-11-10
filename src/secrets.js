// Secret patterns. Only formats with a fixed, recognisable shape are listed,
// so a hit is almost always a real key. Plain-prose passwords are NOT detected.
import { createHash } from 'node:crypto';

/** [id, label, regex source] */
export const PATTERNS = [
  ['anthropic', 'Anthropic API key', 'sk-ant-[A-Za-z0-9_-]{32,}'],
  ['openai', 'OpenAI API key', 'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}'],
  ['github', 'GitHub token', 'gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}'],
  ['gitlab', 'GitLab token', 'glpat-[A-Za-z0-9_-]{20,}'],
  ['aws', 'AWS access key', '(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])'],
  ['google', 'Google API key', 'AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])'],
  ['slack', 'Slack token', 'xox[baprs]-[A-Za-z0-9-]{20,}'],
  ['stripe', 'Stripe live key', '[sr]k_live_[0-9a-zA-Z]{24,}'],
  ['npm', 'npm token', 'npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])'],
  ['huggingface', 'Hugging Face token', 'hf_[A-Za-z0-9]{34,}'],
  ['sendgrid', 'SendGrid key', 'SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}'],
  ['telegram', 'Telegram bot token', '[0-9]{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])'],
  // Body allows real newlines and JSON-escaped ones (\n, \\n) so the whole block is redacted.
  ['privatekey', 'Private key', '-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:[A-Za-z0-9+/=\\s]|\\\\+[nr])*(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----)?'],
  ['dburl', 'Database password in a URL', '(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|amqps?)://[^\\s:@/"\'\\\\]{1,64}:(?<dbpw>[^\\s@"\'\\\\]{6,128})@(?<dbhost>[A-Za-z0-9.-]+)'],
];

export const LABELS = Object.fromEntries(PATTERNS.map(([id, label]) => [id, label]));

const RE = new RegExp(
  '(?<![A-Za-z0-9_-])(?:' + PATTERNS.map(([id, , src]) => `(?<${id}>${src})`).join('|') + ')',
  'g',
);

const PLACEHOLDER = /(.)\1{7,}|x{5,}|example|placeholder|redacted|your[-_]|dummy|fake|sample|changeme|\*{3}|\.{3}|<|\$\{|1234567890|abcdefgh/i;
const WEAK_PW = /^(?:password|postgres|pass|secret|root|admin|test|dev|local|user|mysql|mongo|redis|guest)\w{0,4}$/i;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|mongo|redis|rabbitmq|host\.docker\.internal)$/i;

const typeOf = (groups) => PATTERNS.find(([id]) => groups[id] !== undefined)[0];

// Drop documentation examples, placeholders and local dev defaults.
function isReal(type, whole, groups) {
  if (type === 'privatekey') return whole.length >= 200; // a bare header is just a mention
  if (type === 'dburl') {
    return !WEAK_PW.test(groups.dbpw) && !LOCAL_HOST.test(groups.dbhost) && !PLACEHOLDER.test(groups.dbpw);
  }
  return !PLACEHOLDER.test(whole) && new Set(whole).size >= 10;
}

const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

function mask(type, whole, groups) {
  if (type === 'privatekey') return '-----BEGIN PRIVATE KEY----- …';
  if (type === 'dburl') return whole.replace(':' + groups.dbpw + '@', () => ':••••@');
  return whole.slice(0, 4) + '…' + whole.slice(-2);
}

// Every pattern above contains one of these literals. Searching for them first is about
// twice as fast as running the full pattern over gigabytes of history; the full pattern
// then only checks a small window around each candidate.
const CANDIDATE =
  /sk-ant-|sk-proj-|sk-svcacct-|sk-admin-|T3BlbkFJ|gh[pousr]_|github_pat_|glpat-|AKIA|ASIA|AIza|xox[baprs]-|[sr]k_live_|npm_|hf_|SG\.|:AA|PRIVATE KEY-----|postgres|mysql:|mariadb:|mongodb|rediss?:|amqps?:/g;
const BACK = 80; // a candidate literal sits at most this far after the start of its secret
const SPAN = 700; // longest non-key secret
const KEY_SPAN = 16 << 10; // longest private key block

/**
 * Find secrets in a string. The raw value is never returned: only a masked
 * preview and a short hash used to count the same secret once.
 * @returns {{type:string,index:number,length:number,fp:string,masked:string}[]}
 */
export function findSecrets(text) {
  const out = [];
  let from = 0; // end of the last secret found
  CANDIDATE.lastIndex = 0;
  let c;
  while ((c = CANDIDATE.exec(text))) {
    const start = Math.max(from, c.index - BACK);
    const at = c.index - start;
    const window = text.slice(start, c.index + (c[0].startsWith('PRIVATE') ? KEY_SPAN : SPAN));
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(window)) && m.index <= at) {
      if (m.index + m[0].length <= at) continue; // ends before this candidate
      from = start + m.index + m[0].length;
      if (from > CANDIDATE.lastIndex) CANDIDATE.lastIndex = from;
      const type = typeOf(m.groups);
      if (isReal(type, m[0], m.groups)) {
        out.push({
          type,
          index: start + m.index,
          length: m[0].length,
          fp: fingerprint(type === 'dburl' ? m.groups.dbpw : m[0]),
          masked: mask(type, m[0], m.groups),
        });
      }
      break;
    }
  }
  return out;
}

/** Replace every secret in a string. @returns {{text:string,count:number}} */
export function redactText(text) {
  let count = 0;
  const out = text.replace(RE, (...args) => {
    const whole = args[0];
    const groups = args.at(-1);
    const type = typeOf(groups);
    if (!isReal(type, whole, groups)) return whole;
    count++;
    if (type === 'dburl') return whole.replace(':' + groups.dbpw + '@', () => ':[REDACTED]@');
    return `[REDACTED:${type}]`;
  });
  return { text: out, count };
}
