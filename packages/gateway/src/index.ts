/**
 * zremote-gateway CLI。
 *
 *   node src/index.ts             启动网关（默认 127.0.0.1:7801）
 *   node src/index.ts pair        生成本地一次性配对码
 *   node src/index.ts devices     列出已配对设备
 *   node src/index.ts revoke <id> 撤销设备
 *   node src/index.ts health      健康与能力自检
 *
 * 后端选择：ZREMOTE_BACKEND=mock|real（默认 mock）。
 */
import { loadConfig } from './config.ts';
import { buildGateway } from './server.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    const { startServer } = await import('./server.ts');
    const running = await startServer(config);
    console.log(`[zremote] gateway listening on http://${config.host}:${running.port} (backend=${config.backend})`);
    console.log('[zremote] 仅 loopback 监听；跨机访问请使用 Tailscale Serve（PRD §9）');
    console.log(`[zremote] 管理令牌: ${running.gateway.adminToken()}（状态目录 ${config.stateDir}）`);
    const shutdown = async (): Promise<void> => {
      console.log('[zremote] shutting down');
      await running.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return;
  }

  const { gateway } = buildGateway(config);
  const cmd = argv[0];
  if (cmd === 'pair') {
    const { code, expiresAt } = gateway.createPairing();
    console.log(`配对码: ${code}`);
    console.log(`有效期至: ${expiresAt}（有效期内单次有效）`);
    return;
  }
  if (cmd === 'devices') {
    for (const d of gateway.auth.listDevices()) {
      console.log(`${d.id}  ${d.revoked ? '[已撤销]' : '[活跃]'}  ${d.name}  最近活动: ${d.lastSeenAt ?? '-'}`);
    }
    return;
  }
  if (cmd === 'revoke') {
    const id = argv[1];
    if (!id) {
      console.error('用法: revoke <deviceId>');
      process.exitCode = 1;
      return;
    }
    const ok = gateway.revokeDevice(id);
    console.log(ok ? `已撤销 ${id}（现有订阅已断开）` : `未找到设备 ${id}`);
    if (!ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'health') {
    const h = await gateway.health();
    console.log(JSON.stringify({ ...h, capabilities: gateway.capabilities() }, null, 2));
    return;
  }
  console.error(`未知命令: ${cmd}`);
  console.error('用法: index.ts [pair|devices|revoke <id>|health]');
  process.exitCode = 1;
}

void main();
