import type { HostPrefill } from '../host-channel.js';
import { CliError, type Ctx } from '../runtime.js';

/**
 * The questions an interactive `decisions deploy` asks before it changes anything in the Cloudflare
 * account. A host app can supply defaults for them (`--host-channel`); the person still sees and
 * confirms or changes every one.
 *
 * Provider keys are read with hidden input, checked against the provider at the step that asked for
 * them, and kept in memory: they reach Wrangler only on standard input.
 */

export type TranscriptionProvider = 'xai' | 'openai';
export type CleanupProvider = 'anthropic' | 'openai';
export type KeyProvider = TranscriptionProvider | CleanupProvider;

export const PROVIDER_LABEL: Record<KeyProvider, string> = {
  xai: 'xAI (Grok)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/** The Worker secret each provider's key is stored in (worker/src/env.ts). */
export const KEY_SECRET: Record<KeyProvider, string> = {
  xai: 'XAI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
};

/** The Worker var that names each cleanup provider's model (worker/src/env.ts). */
export const MODEL_VAR: Record<CleanupProvider, string> = {
  anthropic: 'ANTHROPIC_CORRECTION_MODEL',
  openai: 'OPENAI_CORRECTION_MODEL',
};

/** Each provider's cleanup models, its default first: the same list Daintree desktop offers. */
export const CLEANUP_MODELS: Record<CleanupProvider, readonly string[]> = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
  openai: ['gpt-6.1-terra', 'gpt-6-luna'],
};

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface DeployAnswers {
  name: string;
  bucket: string;
  /** The account everything is created in, when it is known. */
  account: CloudflareAccount | null;
  transcription: { provider: TranscriptionProvider } | null;
  cleanup: { provider: CleanupProvider; model: string } | null;
  /** Keys for the providers in use, held in memory only. */
  keys: Partial<Record<KeyProvider, string>>;
  /** Keys the provider could not be asked about, which the user chose to keep anyway. */
  unchecked: KeyProvider[];
}

export type KeyCheck =
  | { ok: true; models?: string[] }
  | { ok: false; rejected: true; status: number }
  | { ok: false; rejected: false; reason: string };

/** The Anthropic API version the relay's own cleanup requests use (worker/src/voice-correct.ts). */
const ANTHROPIC_VERSION = '2026-10-21';

const MODELS_URL: Record<KeyProvider, string> = {
  xai: 'https://api.x.ai/v1/models',
  openai: 'https://api.openai.com/v1/models',
  anthropic: 'https://api.anthropic.com/v1/models?limit=1000',
};

/**
 * Asks the provider whether it accepts `key`, by listing its models. 401 and 403 are a rejection;
 * anything else that is not a success (a network failure, an outage) means the key could not be
 * checked.
 */
export async function checkProviderKey(
  fetcher: typeof fetch,
  provider: KeyProvider,
  key: string,
): Promise<KeyCheck> {
  const headers: Record<string, string> =
    provider === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
      : { authorization: `Bearer ${key}` };
  let res: Response;
  try {
    // A provider key never follows a redirect anywhere.
    res = await fetcher(MODELS_URL[provider], {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // The exception's own text is never shown: only what kind of failure it was.
    const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
    return { ok: false, rejected: false, reason: timedOut ? 'timed out' : 'network error' };
  }
  if (res.status === 401 || res.status === 403)
    return { ok: false, rejected: true, status: res.status };
  if (!res.ok) return { ok: false, rejected: false, reason: `HTTP ${res.status}` };
  try {
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id) => typeof id === 'string');
    return { ok: true, models: models as string[] };
  } catch {
    return { ok: true };
  }
}

/** Names the questions validate, with the message shown for an invalid one. */
export interface NameRule {
  pattern: RegExp;
  hint: string;
}

const MAX_TRIES = 5;

async function ask(ctx: Ctx, question: string): Promise<string> {
  return (await ctx.prompt(question)).trim();
}

async function askYesNo(ctx: Ctx, question: string, dflt: boolean): Promise<boolean> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = (await ask(ctx, `${question} ${dflt ? '[Y/n]' : '[y/N]'} `)).toLowerCase();
    if (!a) return dflt;
    if (a === 'y' || a === 'yes') return true;
    if (a === 'n' || a === 'no') return false;
    ctx.out('    Answer y or n.');
  }
  throw new CliError('no valid answer; nothing was changed');
}

async function askChoice<T extends string>(
  ctx: Ctx,
  question: string,
  options: readonly { value: T; label: string }[],
  dflt: T,
): Promise<T> {
  options.forEach((o, i) =>
    ctx.out(`    ${i + 1}) ${o.label}${o.value === dflt ? ' (default)' : ''}`),
  );
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = await ask(ctx, `${question} [${options.findIndex((o) => o.value === dflt) + 1}] `);
    if (!a) return dflt;
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.value;
    const byValue = options.find((o) => o.value === a.toLowerCase());
    if (byValue) return byValue.value;
    ctx.out(`    Enter a number from 1 to ${options.length}.`);
  }
  throw new CliError('no valid answer; nothing was changed');
}

async function askName(ctx: Ctx, label: string, dflt: string, rule: NameRule): Promise<string> {
  for (let i = 0; i < MAX_TRIES; i++) {
    const a = await ask(ctx, `${label} [${dflt}] `);
    if (!a) return dflt;
    if (rule.pattern.test(a)) return a;
    ctx.out(`    "${a}" is not valid: ${rule.hint}.`);
  }
  throw new CliError('no valid answer; nothing was changed');
}

type KeyAnswer = { key: string; models?: string[]; unchecked?: true };

/**
 * Checks `key` with its provider. Resolves to the answer when it is accepted, or when it could not
 * be checked and the user keeps it anyway; otherwise says why and resolves to null.
 */
async function tryKey(
  ctx: Ctx,
  provider: KeyProvider,
  key: string,
  retry: string,
): Promise<KeyAnswer | null> {
  const check = await checkProviderKey(ctx.fetch, provider, key);
  if (check.ok) {
    ctx.out(`    ${PROVIDER_LABEL[provider]} accepted the key.`);
    return check.models ? { key, models: check.models } : { key };
  }
  if (!check.rejected) {
    ctx.out(`    Could not check the key with ${PROVIDER_LABEL[provider]} (${check.reason}).`);
    if (await askYesNo(ctx, 'Use it without checking?', false)) return { key, unchecked: true };
    ctx.out(`    ${retry}`);
    return null;
  }
  ctx.out(
    `    ${PROVIDER_LABEL[provider]} ${check.status === 403 ? 'denied access with' : 'rejected'} that key (HTTP ${check.status}). ${retry}`,
  );
  return null;
}

/**
 * Asks for a provider's key until the provider accepts it. An empty answer turns the feature off
 * (resolves to null). A key that could not be checked is kept only if the user says so. A key the
 * host app supplied is offered first, shown only as present; it is checked like a typed one, and
 * offered once.
 */
async function askKey(
  ctx: Ctx,
  provider: KeyProvider,
  feature: string,
  onSecret: (v: string) => void,
  prefilled: string | undefined,
): Promise<KeyAnswer | null> {
  const retry = `Enter the key again, or press Enter to leave ${feature} off.`;
  if (prefilled) {
    ctx.out(`    ${PROVIDER_LABEL[provider]} key: present (from the app that started this deploy).`);
    if (await askYesNo(ctx, 'Use this key?', true)) {
      const got = await tryKey(ctx, provider, prefilled, retry);
      if (got) return got;
    } else ctx.out(`    Enter another key, or press Enter to leave ${feature} off.`);
  }
  for (let i = 0; i < MAX_TRIES; i++) {
    const key = (
      await ctx.prompt(`${PROVIDER_LABEL[provider]} API key (input hidden): `, { secret: true })
    ).trim();
    if (!key) {
      ctx.out(`    No key entered: ${feature} is off.`);
      return null;
    }
    onSecret(key);
    const got = await tryKey(ctx, provider, key, retry);
    if (got) return got;
  }
  throw new CliError(`no key ${PROVIDER_LABEL[provider]} accepted; nothing was changed`);
}

export interface QuestionDefaults {
  name: string;
  bucket: string;
  account: CloudflareAccount | null;
  /** Every account the login can use, when there is a choice to make. */
  accounts?: CloudflareAccount[];
  /** The account the choice starts on, when there is one. */
  accountId?: string;
  /** Defaults from the host app for the dictation questions, keys included. */
  prefill?: HostPrefill;
  /** The claim secret goes to the host app instead of the screen. */
  forHost?: boolean;
}

export interface QuestionRules {
  name: NameRule;
  bucket: NameRule;
}

const E2EE_NOTE =
  "Dictation is the one part of Decisions that isn't end-to-end encrypted: the relay and the provider see what you say.";

/**
 * Walks through the setup questions and returns the answers once the user has confirmed the
 * summary, or null if they cancelled. Nothing here touches the Cloudflare account; `onSecret`
 * receives each key as soon as it is typed, so it can be redacted from anything shown later.
 */
export async function askDeployQuestions(
  ctx: Ctx,
  d: QuestionDefaults,
  rules: QuestionRules,
  onSecret: (v: string) => void,
): Promise<DeployAnswers | null> {
  const say = (l = '') => ctx.out(l);

  const pre = d.prefill ?? { keys: {} };
  say('\nWhat will be created');
  let account = d.account;
  if (d.accounts && d.accounts.length > 1 && !account) {
    say('    Your Cloudflare login can use several accounts:');
    const start =
      d.accounts.find((a) => a.id.toLowerCase() === d.accountId?.toLowerCase()) ?? d.accounts[0]!;
    const id = await askChoice(
      ctx,
      'Account to deploy to:',
      d.accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` })),
      start.id,
    );
    account = d.accounts.find((a) => a.id === id)!;
  }
  say(`    Cloudflare account: ${describeAccount(account)}`);
  say('    A Worker (the relay, its Durable Object and the phone app) and a private R2 bucket.');
  say(
    '    Cost: billed under your Cloudflare plan; personal use normally fits the free allowances for Workers, Durable Objects and R2.',
  );
  const name = await askName(ctx, 'Worker name', d.name, rules.name);
  const bucket = await askName(ctx, 'R2 bucket name', d.bucket, rules.bucket);

  const keys: DeployAnswers['keys'] = {};
  const unchecked: KeyProvider[] = [];
  /** The models each provider listed for the key it accepted. */
  const listed: Partial<Record<KeyProvider, string[]>> = {};

  say('\nDictation transcription (optional)');
  say(
    '    Lets you answer by voice in the phone app: the relay streams your speech to xAI or OpenAI and returns the text, billed to your key.',
  );
  say(`    ${E2EE_NOTE}`);
  let transcription: DeployAnswers['transcription'] = null;
  if (await askYesNo(ctx, 'Use dictation?', !!pre.transcription)) {
    const provider = await askChoice<TranscriptionProvider>(
      ctx,
      'Transcription provider:',
      [
        { value: 'xai', label: PROVIDER_LABEL.xai },
        { value: 'openai', label: PROVIDER_LABEL.openai },
      ],
      pre.transcription?.provider ?? 'xai',
    );
    const got = await askKey(ctx, provider, 'dictation', onSecret, pre.keys[provider]);
    if (got) {
      keys[provider] = got.key;
      if (got.unchecked) unchecked.push(provider);
      if (got.models) listed[provider] = got.models;
      transcription = { provider };
    }
  }

  say('\nTranscript cleanup (optional)');
  say(
    '    Sends each dictated transcript to a language model that fixes misheard words and punctuation, billed to your key.',
  );
  say(`    ${E2EE_NOTE}`);
  let cleanup: DeployAnswers['cleanup'] = null;
  if (await askYesNo(ctx, 'Use transcript cleanup?', !!pre.cleanup)) {
    const provider = await askChoice<CleanupProvider>(
      ctx,
      'Cleanup provider:',
      [
        { value: 'anthropic', label: PROVIDER_LABEL.anthropic },
        { value: 'openai', label: PROVIDER_LABEL.openai },
      ],
      pre.cleanup?.provider ?? (transcription?.provider === 'openai' ? 'openai' : 'anthropic'),
    );
    const models = CLEANUP_MODELS[provider];
    // A model the host remembers that is not offered here (an outdated one) is never deployed.
    const wanted = pre.cleanup?.provider === provider ? pre.cleanup.model : undefined;
    if (wanted && !models.includes(wanted))
      say(`    ${wanted} is not offered for cleanup; the default is ${models[0]}.`);
    const model = await askChoice(
      ctx,
      'Cleanup model:',
      models.map((m) => ({ value: m, label: m })),
      wanted && models.includes(wanted) ? wanted : models[0]!,
    );
    let ok = true;
    if (keys[provider]) {
      say(`    Using the ${PROVIDER_LABEL[provider]} key entered for dictation.`);
    } else {
      const got = await askKey(ctx, provider, 'transcript cleanup', onSecret, pre.keys[provider]);
      if (got) {
        keys[provider] = got.key;
        if (got.unchecked) unchecked.push(provider);
        if (got.models) listed[provider] = got.models;
      } else ok = false;
    }
    // An empty list says nothing about the key, so only a list without the model is reported.
    const seen = listed[provider];
    if (ok && seen?.length && !seen.includes(model)) {
      say(
        `    Note: ${PROVIDER_LABEL[provider]} does not list ${model} for this key; cleanup fails until the key can use it.`,
      );
    }
    if (ok) cleanup = { provider, model };
  }

  const answers: DeployAnswers = {
    name,
    bucket,
    account,
    transcription,
    cleanup,
    keys,
    unchecked,
  };
  say('');
  for (const l of summaryLines(answers, d.forHost)) say(l);
  say('');
  if (!(await askYesNo(ctx, 'Deploy with these settings?', false))) return null;
  return answers;
}

export function describeAccount(a: CloudflareAccount | null): string {
  return a ? (a.name ? `${a.name} (${a.id})` : a.id) : 'the account your Cloudflare login uses';
}

/** The confirmation summary. Keys appear only as present or absent. */
export function summaryLines(a: DeployAnswers, forHost = false): string[] {
  const key = (p: KeyProvider) =>
    a.keys[p] ? (a.unchecked.includes(p) ? 'present (not checked)' : 'present') : 'absent';
  return [
    'Summary',
    `    Cloudflare account   ${describeAccount(a.account)}`,
    `    Worker               ${a.name}`,
    `    R2 bucket            ${a.bucket}`,
    `    Dictation            ${a.transcription ? PROVIDER_LABEL[a.transcription.provider] : 'off'}`,
    `    Transcript cleanup   ${a.cleanup ? `${PROVIDER_LABEL[a.cleanup.provider]}, ${a.cleanup.model}` : 'off'}`,
    `    xAI key              ${key('xai')}`,
    `    OpenAI key           ${key('openai')}`,
    `    Anthropic key        ${key('anthropic')}`,
    '    A key already set on an existing Worker with this name is kept.',
    forHost
      ? '    A claim secret is generated and handed to the app that started this deploy, not shown.'
      : '    A claim secret is generated and shown once at the end.',
  ];
}
