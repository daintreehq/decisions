export const REDACTED = '[REDACTED]';

const BLOCK_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
  // Unterminated private key block: drop everything after the header.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g,
];

const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI / Anthropic style
  /\bxai-[A-Za-z0-9]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

// Credential-looking variable names. The name may be the keyword alone (PRIVATE_KEY, PASSPHRASE) or have a prefix
// and/or suffix (DB_PASSWORD, STRIPE_SECRET_KEY). Quantifiers are bounded so long lines cannot cause backtracking blow-ups.
const NAME_KEYWORD =
  '(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE[_-]?KEY|API[_-]?KEY|ACCESS[_-]?KEY|SECRET[_-]?KEY|AUTH[_-]?(?:TOKEN|KEY|SECRET)|AUTHORIZATION)';
const NAME = `[A-Za-z0-9_.-]{0,64}${NAME_KEYWORD}[A-Za-z0-9_.-]{0,64}`;

// KEY=value lines (.env files, shell exports, `key: value` config): redact everything after the separator.
const ENV_LINE = new RegExp(
  `^([ \\t]*(?:export[ \\t]+)?${NAME}[ \\t]*[=:][ \\t]*)(?!\\[REDACTED\\])\\S.*$`,
  'gim',
);
// The same assignments embedded in prose or code: `run with DB_PASSWORD=hunter2 set`.
const INLINE_ASSIGNMENT = new RegExp(
  `(${NAME})([ \\t]*[:=][ \\t]*)(?!\\[REDACTED\\])("[^"\\n]+"|'[^'\\n]+'|[^\\s,;]+)`,
  'gi',
);
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

/** Remove anything that looks like a credential before it is stored, indexed or put in a prompt. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of BLOCK_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of TOKEN_PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  out = out.replace(ENV_LINE, `$1${REDACTED}`);
  out = out.replace(INLINE_ASSIGNMENT, `$1$2${REDACTED}`);
  return out;
}

export function containsSecrets(text: string): boolean {
  return redactSecrets(text) !== text;
}

/** Strip control characters (including ESC sequences' lead byte) from model-produced text. */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  const re = new RegExp(
    '[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u2028\\u2029]',
    'g',
  );
  return text.replace(re, '');
}
