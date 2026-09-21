export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://jimu:jimu@localhost:5432/jimu',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  uploadDir: process.env.UPLOAD_DIR || '/data/uploads',
  // 缓存秒数；设为 0 可关闭
  cacheTtl: Number(process.env.CACHE_TTL ?? 30),
};
