/** 网关配置：全部来自环境变量，默认值对齐 PRD §9/§7.3 */
import path from 'node:path';
import os from 'node:os';

export interface GatewayConfig {
  /** 仅 loopback 监听（PRD §9：不开放公网入站，Tailscale Serve 由外部承担） */
  host: string;
  port: number;
  /** mock | real */
  backend: 'mock' | 'real';
  /** real 后端的 zcode CLI 入口 */
  zcodeEntry: string;
  /** 网关状态库目录（PRD：SQLite + 有界事件缓存） */
  stateDir: string;
  /** 事件保留（PRD §7.3：建议 7 天、可配置、容量上限） */
  eventRetentionDays: number;
  eventRetentionMax: number;
  /** 诊断日志保留（PRD §7.3：建议 14 天） */
  logRetentionDays: number;
  /** 配对码有效期（PRD §9：默认 5 分钟） */
  pairingTtlMs: number;
  pairingMaxAttempts: number;
  /** 单项目并行写任务上限（PRD §7.4：首版默认 1，其余排队） */
  maxConcurrentWritesPerProject: number;
  /** Web 客户端静态目录（可选） */
  webDir?: string;
}

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(): GatewayConfig {
  const stateDir =
    process.env.ZREMOTE_STATE_DIR ?? path.join(os.homedir(), '.local', 'state', 'zremote');
  const backend = process.env.ZREMOTE_BACKEND === 'real' ? 'real' : 'mock';
  return {
    host: '127.0.0.1',
    port: envInt('ZREMOTE_PORT', 7801),
    backend,
    zcodeEntry:
      process.env.ZREMOTE_ZCODE_ENTRY ??
      path.join(
        os.homedir(),
        '.zcode',
        'server',
        'releases',
        '3.17.2-linux-x64-88a41b337faa',
        'runtime',
        'zcode.cjs',
      ),
    stateDir,
    eventRetentionDays: envInt('ZREMOTE_EVENT_RETENTION_DAYS', 7),
    eventRetentionMax: envInt('ZREMOTE_EVENT_RETENTION_MAX', 20000),
    logRetentionDays: envInt('ZREMOTE_LOG_RETENTION_DAYS', 14),
    pairingTtlMs: envInt('ZREMOTE_PAIRING_TTL_MS', 5 * 60 * 1000),
    pairingMaxAttempts: envInt('ZREMOTE_PAIRING_MAX_ATTEMPTS', 5),
    maxConcurrentWritesPerProject: envInt('ZREMOTE_MAX_CONCURRENT_WRITES', 1),
    webDir: process.env.ZREMOTE_WEB_DIR,
  };
}
