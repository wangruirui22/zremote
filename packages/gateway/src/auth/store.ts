/**
 * 认证与设备管理（PRD §9）：
 *  - 一次性配对码：短期、限速、单次使用，Mac 本地生成；
 *  - 设备 token：随机 32 字节，仅存 sha256；
 *  - 撤销：拒绝新请求并断开现有订阅（由 API 层配合执行）；
 *  - 审计：配对、创建、追加、停止、审批、撤销全部入 audit_log。
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { auditDetail } from '../redact.ts';

export interface DeviceRow {
  id: string;
  name: string;
  scope: string;
  revoked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class AuthStore {
  private readonly db: DatabaseSync;
  private readonly opts: { pairingTtlMs: number; pairingMaxAttempts: number };

  constructor(db: DatabaseSync, opts: { pairingTtlMs: number; pairingMaxAttempts: number }) {
    this.db = db;
    this.opts = opts;
  }

  // -- 配对 -------------------------------------------------------------------

  /** Mac 本地生成一次性配对码（明文只出现在此刻的返回值/二维码） */
  createPairingCode(): { code: string; expiresAt: string } {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 位
    const codeHash = sha256(code);
    const expiresAt = new Date(Date.now() + this.opts.pairingTtlMs).toISOString();
    this.db
      .prepare('INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)')
      .run(codeHash, expiresAt);
    this.audit(null, 'pairing_code_created', { expiresAt });
    return { code, expiresAt };
  }

  /** 用配对码换设备 token；限速与单次使用（PRD §9） */
  async pair(code: string, deviceName: string): Promise<{ token: string; device: DeviceRow }> {
    const codeHash = sha256(code.trim().toUpperCase());
    const row = this.db
      .prepare('SELECT * FROM pairing_codes WHERE code_hash = ?')
      .get(codeHash) as { code_hash: string; expires_at: string; used: number; attempts: number } | undefined;
    if (!row) throw new AuthError(401, 'invalid_pairing_code', '配对码无效');
    if (row.used) throw new AuthError(401, 'pairing_code_used', '配对码已使用');
    if (row.attempts >= this.opts.pairingMaxAttempts) {
      throw new AuthError(429, 'pairing_rate_limited', '尝试次数过多');
    }
    if (Date.parse(row.expires_at) < Date.now()) {
      throw new AuthError(401, 'pairing_code_expired', '配对码已过期，请在 Mac 重新生成');
    }
    // 有效（原子消费）
    const upd = this.db.prepare('UPDATE pairing_codes SET used = 1 WHERE code_hash = ? AND used = 0');
    if (Number(upd.run(codeHash).changes) !== 1) {
      throw new AuthError(401, 'pairing_code_used', '配对码已使用');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const device: DeviceRow = {
      id: `dev-${crypto.randomUUID().slice(0, 8)}`,
      name: sanitizeName(deviceName),
      scope: 'control',
      revoked: false,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO devices (id, name, token_hash, scope, revoked, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(device.id, device.name, sha256(token), device.scope, 0, device.createdAt, device.lastSeenAt);
    this.audit(device.id, 'device_paired', { name: device.name });
    return { token, device };
  }

  // -- 认证 -------------------------------------------------------------------

  /** Bearer token → 设备；未认证/已撤销分别抛错 */
  authenticate(header: string | undefined): DeviceRow {
    if (!header || !header.startsWith('Bearer ')) {
      throw new AuthError(401, 'unauthorized', '缺少设备凭据');
    }
    const token = header.slice(7).trim();
    const row = this.db
      .prepare('SELECT * FROM devices WHERE token_hash = ?')
      .get(sha256(token)) as { id: string; name: string; scope: string; revoked: number; created_at: string; last_seen_at: string | null } | undefined;
    if (!row) throw new AuthError(401, 'unauthorized', '设备凭据无效');
    if (row.revoked) throw new AuthError(401, 'device_revoked', '设备已被撤销');
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
    return {
      id: row.id,
      name: row.name,
      scope: row.scope,
      revoked: false,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  listDevices(): DeviceRow[] {
    const rows = this.db.prepare('SELECT * FROM devices ORDER BY created_at').all() as Array<{
      id: string; name: string; scope: string; revoked: number; created_at: string; last_seen_at: string | null;
    }>;
    return rows.map((r) => ({ id: r.id, name: r.name, scope: r.scope, revoked: r.revoked === 1, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
  }

  /** 撤销设备：API 层需同时断开该设备现有 SSE 订阅（PRD §9） */
  revoke(deviceId: string): boolean {
    const r = this.db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(deviceId);
    this.audit(null, 'device_revoked', { deviceId });
    return Number(r.changes) > 0;
  }

  // -- 审计 -------------------------------------------------------------------

  audit(deviceId: string | null, action: string, detail: Record<string, unknown> = {}): void {
    this.db
      .prepare('INSERT INTO audit_log (at, device_id, action, detail_json) VALUES (?,?,?,?)')
      .run(new Date().toISOString(), deviceId, action, auditDetail(detail));
  }
}

function sanitizeName(name: string): string {
  const n = (name || 'unnamed-device').trim();
  return n.slice(0, 64).replace(/[\u0000-\u001f<>]/g, '');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}
