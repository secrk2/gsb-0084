// 输出应用数量（供 entrypoint 判断是否需要种子）
import { pool } from '../src/db.js';

pool
  .query('SELECT count(*)::int AS n FROM apps')
  .then(({ rows }) => {
    process.stdout.write(String(rows[0].n));
    return pool.end();
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
