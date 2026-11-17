import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuestionStore, type QuestionView } from '../src/domain/model.js';
import { AgentMessage } from '../src/components/workspace/Thread.js';
import { makeWorld, questionEvent, SAMPLE_CONTENT } from './helpers.js';

/** A question as the phone verifies and shows it, asked with `content`. */
async function asked(content: unknown): Promise<QuestionView> {
  const w = await makeWorld();
  const s = new QuestionStore({
    installationId: w.installationId,
    trust: w.trust,
    epochKeys: () => w.epochs,
  });
  const ev = await questionEvent(w, { content });
  await s.ingest(ev);
  return s.get(ev.question_id!)!;
}

const render = (v: QuestionView) =>
  renderToStaticMarkup(
    <AgentMessage view={v} now={Date.now()} headingRef={createRef<HTMLDivElement>()} />,
  );

describe('the agent’s preparation report on a question', () => {
  it('is shown as the agent’s own account, with its summary as plain text', async () => {
    const v = await asked({
      ...SAMPLE_CONTENT,
      preparation: {
        preference_revision: 4,
        agents_consulted: 3,
        outcome: 'agreed',
        summary: 'All three prefer the compact sidebar. <img src=x onerror=alert(1)>',
      },
    });
    expect(v.verification).toEqual({ ok: true });
    const html = render(v);
    expect(html).toContain('The agent’s account');
    expect(html).toContain('It says it consulted 3 other agents and they agreed.');
    expect(html).toContain('All three prefer the compact sidebar.');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img');
    // An account, never an answer or a verified fact.
    expect(html).not.toMatch(/verified|approved|answered/i);
  });

  it('says so when the agents did not agree, or no consultation ran', async () => {
    const split = await asked({
      ...SAMPLE_CONTENT,
      preparation: { agents_consulted: 2, outcome: 'split', summary: 'One for each.' },
    });
    expect(render(split)).toContain('It says it consulted 2 other agents and they didn’t agree.');
    const none = await asked({
      ...SAMPLE_CONTENT,
      preparation: { agents_consulted: 0, outcome: 'not-run', summary: 'No subagents here.' },
    });
    expect(render(none)).toContain('It says no consultation took place.');
    expect(render(none)).toContain('No subagents here.');
  });

  it('an older question without one renders as before', async () => {
    const html = render(await asked(SAMPLE_CONTENT));
    expect(html).not.toContain('msg-prep');
    expect(html).not.toContain('The agent’s account');
  });

  it('a malformed report never makes the question unreadable: it is left out', async () => {
    const v = await asked({
      ...SAMPLE_CONTENT,
      preparation: { agents_consulted: 'many', outcome: 'unanimous' },
    });
    expect(v.verification).toEqual({ ok: true });
    expect(v.content?.question).toBe(SAMPLE_CONTENT.question);
    expect(render(v)).not.toContain('msg-prep');
  });
});
