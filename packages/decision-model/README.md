# @daintree/decisions-model

The optional **decision model** for Daintree Decisions: it predicts how _you_ would answer a question an agent
asked, using only your own past decisions, and it either drafts a suggestion for you or (when you have explicitly
allowed it) gives a clearly labelled **proxy answer**.

It runs on the desktop, where the encryption keys are. The relay never sees any of this.

## What it will and will not do

- It **never** answers a `human-required` question. That check happens first, again at the end, and is covered by a
  fuzz test that throws hostile model output at a fully authorised engine.
- It is **suggestion-only by default**. An automatic proxy answer needs _both_ an operator-chosen
  `autoAnswerThreshold` _and_ calibration data from a chronological replay of your own history
  (`minCalibrationSamples`, default 30). Without both, `suggest()` abstains and attaches the draft for display.
- It abstains rather than guesses: too little history, contradictory history, ambiguous options, blocked
  gates/topics, suspected prompt injection, any invalid model output, timeouts, or a busy queue.
- The model's `confidence` is its own estimate, not a probability. Never show or treat it as one.

## Usage

```ts
import {
  SqliteHistoryStore,
  createDecisionModel,
  commandPresets, // or AnthropicAdapter / OpenAIAdapter
  formatReport,
} from '@daintree/decisions-model';

const history = new SqliteHistoryStore('/path/to/decision-history.sqlite');
history.setLearningEnabled(true); // off by default: nothing is recorded until you opt in

// After the human answers (source must be 'human'; proxy output is rejected):
history.record({
  question_id,
  question,
  options,
  selected_option_ids,
  human_reasoning,
  created_at,
  chosen_at,
  policy_level: 'proxy-ok',
  source: 'human',
});

const model = createDecisionModel({
  history,
  adapter: commandPresets.claude(), // runs your installed agent CLI non-interactively
  policy: { minExamples: 3 }, // suggestion-only
});

await model.suggestOnly(question); // draft for the human; works for human-required too
await model.suggest(question); // ProxyEngine: answer | abstain (+ suggestion)

// Earn auto-answers: replay your history, then opt in deliberately.
const report = await model.evaluate({ targetAccuracy: 0.9, minSamples: 30 });
console.log(formatReport(report));
model.setCalibration(report.calibration);
model.setAutoAnswerThreshold(0.85); // effective threshold is max(this, calibrated recommendation)
```

`ProxyEngine` (`suggest(input, signal?) → ProxyOutcome`) is the structural interface `DecisionsBridge` consumes. The
`abstain` branch may carry an optional `suggestion` for display; ignore it if you only need the contract.

## Privacy

- History lives in a local SQLite file (or memory). It is never synced anywhere by this package.
- Secrets (API keys, tokens, JWTs, private key blocks, `.env`-style lines, URL credentials) are redacted
  **before storage and again before prompting**. Redaction catches common formats only; it is not a guarantee.
- Per-project opt-out: `setProjectOptOut(tag, true)` stops recording and deletes what was learned from that project.
  `forget(id)`, `clear()` and `rebuildIndex()` are available. Deleting an example from the model does not delete the
  decision transcript elsewhere.
- **Where the prompt goes depends on the adapter.** `CommandAdapter` sends it to the CLI you configured (which talks to
  that CLI's own provider). `AnthropicAdapter` and `OpenAIAdapter` call a cloud API and refuse to run unless you set
  `consentToSendHistory: true`. For the strongest privacy use a local model through a command adapter.
- `CommandAdapter` uses no shell, a scrubbed environment (allowlist; pane tokens such as `DAINTREE_MCP_TOKEN` are never
  passed), a temp working directory, a hard timeout, an output cap, and kills the whole process group on abort.
  The presets for `claude -p`, `codex exec` and `gemini -p` are **examples**: verify the flags against your installed
  version and override `args` as needed.

## How it decides

1. Hard pre-checks (no model call): `human-required`, blocked workflow gates (design-review / final-approval by
   default), blocked topics (legal, compliance, payment, security, secrets, credentials, destructive, irreversible),
   prompt-injection heuristics, missing or ambiguous options.
2. Retrieval: BM25 over question, context, option labels and your reasoning, blended with recency, project-tag overlap
   and option-structure similarity. Contradicting decisions with overlapping options are pulled in on purpose; if the
   top ones disagree the engine abstains.
3. One inference per question content, cached and de-duplicated, with a concurrency limit, a bounded queue
   (backpressure → `busy`), a strict deadline and transient-only retries.
4. The reply must be a single JSON object that passes a strict schema: chosen ids ⊆ offered ids, exactly one for
   choice/approval, text within `LIMITS.answerTextBytes`, confidence in [0,1], supporting ids ⊆ the examples actually
   shown, model risk flags honoured. Anything else is an abstention.

The prompt treats the question, context, options and your past examples as untrusted _data_ inside a random
boundary and tells the model to ignore instructions found there.

## Evaluation and fine-tuning

`evaluateHistory` / `model.evaluate()` replays decisions oldest-first, predicting each from only the decisions before
it. It reports accuracy by confidence bucket, coverage, per-kind accuracy, disagreement and a conservative
recommended threshold (smallest confidence whose "and above" band meets the target with enough samples, else `null`).

`exportForFineTuning(history)` emits chat JSONL of your human, non-reversed, redacted decisions for the optional
phase-2 path.

> **Warning:** that file contains your private decision history. Review it, keep it local unless you deliberately
> upload it, and remember automatic redaction only catches common credential formats. Never mix in proxy answers.

## Limits

- Lexical retrieval only (no embeddings); similar decisions phrased in very different words may be missed.
- Free-text questions are never scored by the evaluation harness and should stay human-answered in practice.
- The FTS5 prefilter (large histories) re-ranks a limited candidate set, so scores can differ slightly from the
  in-memory path; behaviour is otherwise identical.
- API adapters need current model ids from your provider account; only the Anthropic default
  (`claude-haiku-5-5`) is preset, and the OpenAI adapter requires an explicit model.
