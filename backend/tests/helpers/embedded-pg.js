import EmbeddedPostgres from 'embedded-postgres';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pg = new EmbeddedPostgres({
  databaseDir: join(tmpdir(), `jimu-pg-${process.env.JIMU_PG_PORT || 54399}`),
  port: Number(process.env.JIMU_PG_PORT || 54399),
  user: 'jimu',
  password: 'jimu',
  persistent: false,
  // 当前镜像只有 C locale，覆盖包装层硬编码的 en_US.UTF-8（后者在本机非法会导致 initdb 失败）
  initdbFlags: ['--lc-messages=C'],
  onLog: () => {},
  onError: (m) => console.error('[pg]', m),
});

export async function startTestPg() {
  await pg.initialise();
  await pg.start();
  const dbName = process.env.JIMU_PG_DB || 'jimu_test';
  await pg.createDatabase(dbName);
  return {
    databaseUrl: `postgres://jimu:jimu@127.0.0.1:${process.env.JIMU_PG_PORT || 54399}/${dbName}`,
    async stop() {
      try { await pg.stop(); } catch { /* ignore */ }
    },
  };
}
