import { createApp, prepareStorage } from './app.js';
import { migrate, pingDb } from './db.js';
import { initRedis } from './redis.js';
import { config } from './config.js';

async function main() {
  await migrate();
  await pingDb();
  await prepareStorage();
  initRedis();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`积木后端已启动: http://0.0.0.0:${config.port}`);
    console.log(`数据库: ${config.databaseUrl.replace(/:[^:@/]*@/, ':***@')}`);
  });
}

main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
