// 仅执行建表迁移（容器启动时调用）
import { migrate, pingDb, pool } from '../src/db.js';

migrate()
  .then(pingDb)
  .then(() => {
    console.log('数据库迁移完成');
    return pool.end();
  })
  .catch((e) => {
    console.error('迁移失败:', e);
    process.exit(1);
  });
