import type { AgentResumeAdapter, TerminalTarget } from './sink.js';
import type { QuestionOrigin } from './types.js';

/**
 * Resume adapters.
 *
 * Daintree already knows how to resume panes: its agent registry has a `resume` block per CLI
 * (Claude `--resume <id>`, Codex `resume <id>`, Gemini `--resume <id>`; see `shared/config/agents/*.ts` and
 * `src/services/agentResume.ts` in the Daintree repo). Resuming is Daintree's job, not this package's, so
 * the stubs below deliberately do not spawn anything: they report `supported: false` and explain why. A
 * Daintree integration replaces them with an adapter that calls its own resume service, and only after it
 * has an acceptance test proving the original host/worktree/session was restored.
 */
export function unsupportedResumeAdapter(kind: string): AgentResumeAdapter {
  return {
    kind,
    async probe() {
      return {
        supported: false,
        reason: `no verified resume implementation for "${kind}" in the standalone client; the host application supplies one`,
      };
    },
    async canResume() {
      return false;
    },
    async resume() {
      throw new Error(`resume is not supported for "${kind}" by this adapter`);
    },
  };
}

export const claudeResumeAdapter = unsupportedResumeAdapter('claude');
export const codexResumeAdapter = unsupportedResumeAdapter('codex');

/** Test / demo adapter: resumes into a prepared target. */
export function fakeResumeAdapter(kind: string, target: TerminalTarget | null): AgentResumeAdapter {
  return {
    kind,
    async probe() {
      return { supported: target !== null };
    },
    async canResume(_o: QuestionOrigin) {
      return target !== null;
    },
    async resume() {
      if (!target) throw new Error('cannot resume');
      return { target, ready: true };
    },
  };
}

export function pickResumeAdapter(
  adapters: AgentResumeAdapter[],
  origin: QuestionOrigin,
): AgentResumeAdapter | undefined {
  return adapters.find((a) => a.kind === origin.agent_kind);
}
