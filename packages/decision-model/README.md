# @daintreehq/decisions-model

The optional **decision model** for Daintree Decisions: it predicts how _you_ would answer a question an agent
asked, using only your own past decisions, and it either drafts a suggestion for you or (when you have explicitly
allowed it) gives a clearly labelled **proxy answer**.

It runs on the desktop, where the encryption keys are. The relay never sees any of this.

## What it will and will not do

- It **never** answers a `human-required` question. That check happens first, again at the end, and is covered by a
  fuzz test that throws hostile model output at a fully authorised engine.
- It is **suggestion-only by default**. An automatic proxy answer needs _both_ an operator-chosen
  `autoAnswerThreshold` _and_ calibration evidence for that exact threshold: at least `minCalibrationSamples`
  (default 30) replayed predictions at or above it, whose accuracy meets the calibration's target (never below
  `minTargetAccuracy`, default 0.8). A threshold the evidence does not support is ignored, so choosing 0.9 on the
  strength of a good 0.8 band does nothing. Without both, `suggest()` abstains and attaches the draft for display.
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
} from '@daintreehq/decisions-model';

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
model.setAutoAnswerThreshold(0.85); // honoured only if the replay supports exactly 0.85
model.effectiveThreshold(); // 0.85, or null while suggestion-only
```

Record the question's ledger revision when you can (`revision` = the revision after the human action, for example `1`
for the first answer and `2` for an override). Corrections are then ordered by revision rather than by wall-clock
time, an equal revision with the same label is an idempotent no-op (`{ recorded: true, duplicate: true }`), and an
equal revision with a different label is rejected (`stale-revision`). Without a revision the store falls back to
`chosen_at`, where an equal timestamp can only be a duplicate.

## Using it with `DecisionsBridge`

`ProxyEngine` (`suggest(input, signal?) → ProxyOutcome`) is the model's own contract (snake_case fields). The bridge
in `packages/client` declares a separate structural hook with different names (`questionId`, `createdAt`,
`projectId`) and no `kind` or workflow gate, so passing a model straight to it would silently skip the gate and kind
checks and the self-example exclusion. Use the explicit adapter instead:

```ts
import { asBridgeEngine, createDecisionModel } from '@daintreehq/decisions-model';

const model = createDecisionModel({ history, adapter, policy });
const bridge = new DecisionsBridge({
  /* ... */
  proxy: asBridgeEngine(model, {
    // The bridge does not send the gate today: look it up so gate-based blocks (design review, ...) still apply.
    resolveGateId: (q) => gateFor(q.questionId),
    // Recommended: abstain rather than run without a gate id.
    requireGateId: true,
  }),
});
```

| Bridge field                               | Model field              | Notes                                                                           |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------- |
| `questionId`                               | `question_id`            | Also excludes the question from its own evidence                                |
| `createdAt`                                | `created_at`             |                                                                                 |
| `projectId`                                | `project_tags: [id]`     | Drives project-tag relevance and per-project opt-out                            |
| `workflowGateId` or `resolveGateId(input)` | `workflow_gate_id`       | Needed for the gate hard block; `requireGateId` makes its absence an abstention |
| `kind` (optional)                          | `kind`                   | Inferred when absent: no options → `text`, otherwise `choice` (exactly one)     |
| `requirement`, `options`, `context`        | same                     | `human-required` is refused even if a caller bypasses the type                  |
| `attachments` (optional)                   | `attachments`            |                                                                                 |
| _(returned)_                               | `ProxyOutcome` unchanged | Malformed input abstains with `invalid-input`                                   |

`BridgeProxyQuestionInput` and `BridgeProxyEngine` are exported so the two sides can share one contract. The
`abstain` branch of `ProxyOutcome` may carry an optional `suggestion` for display; ignore it if you only need the
contract.

## Privacy

- History lives in a local SQLite file (or memory). It is never synced anywhere by this package.
- Secrets (API keys, tokens, JWTs, private key blocks, `.env`-style and inline `NAME=value` credentials such as
  `PRIVATE_KEY`, `ACCESS_KEY`, `PASSPHRASE`, URL credentials) are redacted **before storage and again before
  prompting**, including options and earlier labels in `label_history`; `rebuildIndex()` re-redacts stored data.
  Redaction catches common formats only; it is not a guarantee.
- Per-project opt-out: `setProjectOptOut(tag, true)` stops recording and deletes what was learned from that project.
  `forget(id)`, `clear()` and `rebuildIndex()` are available and also purge the FTS index, even when the FTS
  prefilter is disabled. Deleting an example from the model does not delete the decision transcript elsewhere.
- **Where the prompt goes depends on the adapter.** `CommandAdapter` sends it to the CLI you configured (which talks to
  that CLI's own provider). `AnthropicAdapter` and `OpenAIAdapter` call a cloud API and refuse to run unless you set
  `consentToSendHistory: true`. For the strongest privacy use a local model through a command adapter.
- `CommandAdapter` uses no shell, a scrubbed environment (allowlist; pane tokens such as `DAINTREE_MCP_TOKEN` are never
  passed), a temp working directory, a hard timeout, an output cap, and kills the whole process group on abort.
  Its errors carry only the command name and exit code: the CLI's stderr is never kept, because CLIs echo credentials
  and prompt text into it. The presets for `claude -p`, `codex exec` and `gemini -p` are **examples**: verify the flags against your installed
  version and override `args` as needed.

## How it decides

1. Hard pre-checks (no model call): `human-required`, blocked workflow gates (design-review / final-approval by
   default; regex entries are applied statelessly, so `g`/`y` flags cannot make a block intermittent), blocked topics (legal, compliance, payment, security, secrets, credentials, destructive, irreversible),
   prompt-injection heuristics, missing or ambiguous options.
2. Retrieval: BM25 over question, context, option labels and your reasoning, blended with recency, project-tag overlap
   and option-structure similarity. Contradicting decisions with overlapping options are searched for across every
   scored candidate (not just the displayed ones) and pulled in on purpose, making room even when the cap is full; if
   the top ones disagree the engine abstains. The minimum evidence (`minExamples`) is enforced on the examples that
   actually fit in the prompt, not on what retrieval found before truncation.
3. One inference per question content, cached and de-duplicated, with a concurrency limit, a bounded queue
   (backpressure → `busy`), a strict deadline and transient-only retries. If the history changes while the model is
   running (a correction, a `forget`, a `clear`), the result is discarded with `stale-history` rather than used on
   evidence that no longer exists.
4. The whole reply must be a single JSON object (optionally in one code fence) that passes a strict schema; prose
   around an object is never salvaged: chosen ids ⊆ offered ids, exactly one for
   choice/approval, text within `LIMITS.answerTextBytes`, confidence in [0,1], supporting ids ⊆ the examples actually
   shown, model risk flags honoured. Anything else is an abstention.

The prompt treats the question, context, options and your past examples as untrusted _data_ inside a random
boundary and tells the model to ignore instructions found there.

## Evaluation and fine-tuning

`evaluateHistory` / `model.evaluate()` replays two kinds of event in time order: a question being **asked**
(`created_at`) and its human answer being **committed** (`chosen_at`). Each question is predicted when it was asked,
seeing only labels committed strictly earlier, so a slow answer never benefits from answers that arrived while it was
pending. Examples that are not `source: 'human'` are dropped before anything is scored or learned
(`rejected_non_human`). It reports accuracy by confidence bucket, coverage, per-kind accuracy, disagreement and a
conservative recommended threshold (smallest confidence whose "and above" band meets the target with enough samples,
else `null`). The returned `calibration` carries every scored (confidence, correct) point so the engine can verify the
exact threshold you pick.

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
