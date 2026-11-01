import type { LocalStore } from './store.js';
import type {
  AuditEntry,
  InboundEvent,
  InjectionIntent,
  OutboxItem,
  QuestionRow,
} from './types.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryLocalStore implements LocalStore {
  private meta = new Map<string, string>();
  private questions = new Map<string, QuestionRow>();
  private outbox = new Map<string, OutboxItem>();
  private events = new Map<number, InboundEvent>();
  private intents = new Map<string, InjectionIntent>();
  private audit: AuditEntry[] = [];
  private alias = 0;

  async getMeta(key: string) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string) {
    this.meta.set(key, value);
  }
  async nextAlias() {
    return ++this.alias;
  }
  async commitNewQuestion(row: QuestionRow, outbox: OutboxItem) {
    if (this.questions.has(row.question_id)) throw new Error('duplicate question');
    this.questions.set(row.question_id, clone(row));
    this.outbox.set(outbox.id, clone(outbox));
  }
  async getQuestion(id: string) {
    const q = this.questions.get(id);
    return q ? clone(q) : null;
  }
  async updateQuestion(id: string, patch: Partial<QuestionRow>) {
    const q = this.questions.get(id);
    if (!q) return null;
    Object.assign(q, clone(patch));
    return clone(q);
  }
  async listQuestions(filter: { status?: QuestionRow['local_status'][]; paneId?: string } = {}) {
    return [...this.questions.values()]
      .filter((q) => !filter.status || filter.status.includes(q.local_status))
      .filter((q) => !filter.paneId || q.origin.pane_id === filter.paneId)
      .sort((a, b) => a.alias - b.alias)
      .map(clone);
  }
  async countOpenForPane(hostId: string, paneId: string) {
    return [...this.questions.values()].filter(
      (q) =>
        q.origin.host_id === hostId &&
        q.origin.pane_id === paneId &&
        (q.local_status === 'queued' || q.local_status === 'open'),
    ).length;
  }
  async putOutbox(item: OutboxItem) {
    this.outbox.set(item.id, clone(item));
  }
  async dueOutbox(now: number, limit: number) {
    return [...this.outbox.values()]
      .filter((o) => o.next_attempt_at <= now)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit)
      .map(clone);
  }
  async recordOutboxFailure(id: string, error: string, nextAttemptAt: number) {
    const o = this.outbox.get(id);
    if (!o) return;
    o.attempts += 1;
    o.last_error = error;
    o.next_attempt_at = nextAttemptAt;
  }
  async deleteOutbox(id: string) {
    this.outbox.delete(id);
  }
  async outboxFor(questionId: string) {
    return [...this.outbox.values()].filter((o) => o.question_id === questionId).map(clone);
  }
  async insertEvent(ev: InboundEvent) {
    if (this.events.has(ev.seq)) return false;
    this.events.set(ev.seq, clone(ev));
    return true;
  }
  async markEventProcessed(seq: number, at: number) {
    const e = this.events.get(seq);
    if (e) e.processed_at = at;
  }
  async unprocessedEvents(limit: number) {
    return [...this.events.values()]
      .filter((e) => e.processed_at === null)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map(clone);
  }
  async getCursor() {
    return Number(this.meta.get('cursor') ?? '0');
  }
  async advanceCursor() {
    let c = await this.getCursor();
    while (this.events.has(c + 1)) c++;
    this.meta.set('cursor', String(c));
    return c;
  }
  async forceCursor(seq: number) {
    if (seq > (await this.getCursor())) this.meta.set('cursor', String(seq));
  }
  async putIntent(i: InjectionIntent) {
    this.intents.set(i.injection_id, clone(i));
  }
  async updateIntent(id: string, patch: Partial<InjectionIntent>) {
    const i = this.intents.get(id);
    if (!i) return null;
    Object.assign(i, clone(patch));
    return clone(i);
  }
  async getIntent(id: string) {
    const i = this.intents.get(id);
    return i ? clone(i) : null;
  }
  async openIntents() {
    return [...this.intents.values()]
      .filter((i) => i.state === 'intent' || i.state === 'typed')
      .map(clone);
  }
  async appendAudit(e: AuditEntry) {
    this.audit.push(clone(e));
  }
  async listAudit(limit: number) {
    return this.audit.slice(-limit).map(clone);
  }
  async close() {}
}
