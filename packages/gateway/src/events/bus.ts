/**
 * 事件总线（PRD §7.3）：网关统一 streamSeq、SQLite 持久化、SSE 补发。
 *  - publish：分配递增序号，先落库再分发；重复 event_id 丢弃（客户端按 event_id 去重的服务端侧对等）；
 *  - subscribe(from)：从游标起回放 + 实时；游标超出保留窗口返回需要快照的信号；
 *  - 保留窗口：按天数与条数双上限裁剪（PRD §7.3：7 天、可配置、容量上限）。
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AdapterEvent, EventKind } from '../adapter/types.ts';

export interface GatewayEvent {
  eventId: string;
  streamSeq: number;
  taskId: string;
  runId?: string;
  kind: EventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface ReplayResult {
  /** false 表示游标超出保留窗口，客户端必须取最新快照重建 */
  continuous: boolean;
  latestSeq: number;
  events: GatewayEvent[];
}

export class EventBus {
  private handlers = new Set<(e: GatewayEvent) => void>();
  private readonly db: DatabaseSync;
  private readonly retention: { days: number; max: number };

  constructor(db: DatabaseSync, retention: { days: number; max: number }) {
    this.db = db;
    this.retention = retention;
  }

  /** Adapter 事件 → 网关事件（先持久化，后分发） */
  publishFromAdapter(e: AdapterEvent): GatewayEvent | null {
    const existing = this.db.prepare('SELECT stream_seq FROM events WHERE event_id = ?').get(e.nativeEventId) as
      | { stream_seq: number }
      | undefined;
    if (existing) return null; // 原生重放事件去重
    const info = this.db
      .prepare('INSERT INTO events (event_id, task_id, run_id, kind, occurred_at, payload_json) VALUES (?,?,?,?,?,?)')
      .run(e.nativeEventId, e.taskId, e.runId ?? null, e.kind, e.occurredAt, JSON.stringify(e.payload));
    const gw: GatewayEvent = {
      eventId: e.nativeEventId,
      streamSeq: Number(info.lastInsertRowid),
      taskId: e.taskId,
      runId: e.runId,
      kind: e.kind,
      occurredAt: e.occurredAt,
      payload: e.payload,
    };
    for (const h of [...this.handlers]) h(gw);
    this.prune();
    return gw;
  }

  /** 手动注入网关侧事件（如审批过期） */
  publish(taskId: string, kind: EventKind, payload: Record<string, unknown>, eventId?: string): GatewayEvent {
    const id = eventId ?? `gw-${kind}-${crypto.randomUUID().slice(0, 8)}`;
    const info = this.db
      .prepare('INSERT INTO events (event_id, task_id, kind, occurred_at, payload_json) VALUES (?,?,?,?,?)')
      .run(id, taskId, kind, new Date().toISOString(), JSON.stringify(payload));
    const gw: GatewayEvent = {
      eventId: id,
      streamSeq: Number(info.lastInsertRowid),
      taskId,
      kind,
      occurredAt: new Date().toISOString(),
      payload,
    };
    for (const h of [...this.handlers]) h(gw);
    return gw;
  }

  subscribe(handler: (e: GatewayEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  latestSeq(): number {
    const r = this.db.prepare('SELECT MAX(stream_seq) AS m FROM events').get() as { m: number | null };
    return r.m ?? 0;
  }

  /** 游标之后回放；游标不存在且早于窗口起点 → continuous=false（要求快照重建） */
  replayAfter(cursor: number, limit = 500): ReplayResult {
    const latest = this.latestSeq();
    if (cursor >= latest) return { continuous: true, latestSeq: latest, events: [] };
    const minRow = this.db.prepare('SELECT MIN(stream_seq) AS m FROM events').get() as { m: number | null };
    const min = minRow.m ?? 0;
    if (cursor > 0 && cursor < min - 1) {
      return { continuous: false, latestSeq: latest, events: [] };
    }
    const rows = this.db
      .prepare('SELECT * FROM events WHERE stream_seq > ? ORDER BY stream_seq ASC LIMIT ?')
      .all(cursor, limit) as Array<{
      stream_seq: number; event_id: string; task_id: string; run_id: string | null; kind: string; occurred_at: string; payload_json: string;
    }>;
    return {
      continuous: true,
      latestSeq: latest,
      events: rows.map((r) => ({
        eventId: r.event_id,
        streamSeq: r.stream_seq,
        taskId: r.task_id,
        runId: r.run_id ?? undefined,
        kind: r.kind as EventKind,
        occurredAt: r.occurred_at,
        payload: JSON.parse(r.payload_json) as Record<string, unknown>,
      })),
    };
  }

  /** 按天数与条数双上限裁剪 */
  prune(): void {
    const cutoff = new Date(Date.now() - this.retention.days * 86400_000).toISOString();
    this.db.prepare('DELETE FROM events WHERE occurred_at < ?').run(cutoff);
    this.db
      .prepare(
        'DELETE FROM events WHERE stream_seq NOT IN (SELECT stream_seq FROM events ORDER BY stream_seq DESC LIMIT ?)',
      )
      .run(this.retention.max);
  }
}
