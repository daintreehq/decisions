import { expect } from 'vitest';
import type { Page } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  approveCandidate,
  createPairingInvite,
  localShortCode,
  type LocateResult,
  type QuestionOrigin,
  type RelayClient,
  type TerminalSink,
  type TerminalTarget,
} from '@daintreehq/decisions-client';
import { until } from './harness.js';

/*
 * What the MCP suites share: agents in terminal panes talking to the MCP server through the official SDK client, the
 * terminals Daintree would type into, and a phone paired the way a person pairs one.
 */

/** The origin of an agent in `pane`, as the host's authenticator resolves it from the pane's bearer. */
export const paneOrigin = (pane: string): QuestionOrigin =>
  ({
    host_id: 'host_mcp0001',
    pane_id: pane,
    terminal_generation: 1,
    ownership_principal: `principal-${pane}`,
    agent_incarnation: `inc-${pane}`,
    agent_kind: 'claude-code',
    agent_session_id: `sess-${pane}`,
    project_id: 'proj',
    worktree_id: 'wt',
    worktree_root: '/tmp/mcp-e2e',
    workflow_gate_id: null,
  }) as QuestionOrigin;

/** One terminal per pane, recording what Daintree would type into each. */
export class PaneSink implements TerminalSink {
  typed: { pane: string; text: string; injectionId: string }[] = [];
  async locate(o: QuestionOrigin): Promise<LocateResult> {
    return {
      state: 'alive',
      target: {
        hostId: o.host_id,
        paneId: o.pane_id,
        terminalGeneration: o.terminal_generation,
        ownershipPrincipal: o.ownership_principal,
        agentIncarnation: o.agent_incarnation,
        agentSessionId: o.agent_session_id,
        worktreeId: o.worktree_id,
      },
    };
  }
  async isIdle() {
    return true;
  }
  async inject(t: TerminalTarget, text: string, injectionId: string) {
    this.typed.push({ pane: t.paneId, text, injectionId });
    return { outcome: 'delivered' as const, proof: 'e2e' };
  }
  async hasMarker(t: TerminalTarget, id: string) {
    return this.typed.some((x) => x.pane === t.paneId && x.text.includes(`injection_id: ${id}`));
  }
  async resume() {
    return null;
  }
}

export type ToolResult = {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** An agent's MCP session, authenticated as the pane `token` belongs to. */
export async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: 'decisions-e2e-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

export const callTool = async (c: Client, name: string, args: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args })) as ToolResult;

/** Pairs `page` as a phone, checking the short code it shows against the computer's, and waits for Home. */
export async function pairPhone(page: Page, relayClient: RelayClient): Promise<void> {
  const invite = await createPairingInvite(relayClient, 'phone');
  await page.goto(invite.url);
  await page.getByRole('button', { name: 'Pair this device' }).click();
  await page.getByText('Check that this matches your computer').waitFor({ timeout: 20_000 });
  const shown = (await page.locator('.pair-digits').innerText()).replace(/\s/g, '');
  const cand = await until(
    async () =>
      (await relayClient.pendingPairings()).pending.find((p) => p.pairing_id === invite.pairingId),
    20_000,
    'pending pairing',
  );
  expect((await localShortCode(cand)).replace(/\s/g, '')).toBe(shown);
  await approveCandidate(relayClient, cand);
  await page.waitForURL((u) => u.pathname === '/', { timeout: 30_000 });
}

/**
 * Opens a question from the inbox, as a person would the first time. Home can render from its cache before the
 * question syncs, and then holds it behind "N new questions" (rows never reshuffle): take it the way a person would.
 */
export async function openFromInbox(page: Page, origin: string, text: string): Promise<void> {
  await page.goto(`${origin}/`);
  const row = page.locator('main').getByText(text).first();
  await until(
    async () => {
      const pill = page.locator('main .nav-new');
      if (await pill.isVisible().catch(() => false)) await pill.click();
      return row.isVisible().catch(() => false);
    },
    30_000,
    `"${text}" listed on Home`,
  );
  await row.click();
}
