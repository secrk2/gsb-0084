import Redis from 'ioredis';
import { config } from './config.js';

// Redis 连接失败时降级为直查，不拖垮服务
let client = null;
let ready = false;

export function initRedis() {
  client = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    retryStrategy(times) {
      return times > 3 ? null : Math.min(times * 200, 1000);
    },
  });
  client.on('ready', () => {
    ready = true;
    console.log('[redis] 已连接');
  });
  client.on('error', () => {
    ready = false;
  });
  return client;
}

export async function cacheGet(key) {
  if (!ready || config.cacheTtl <= 0) return null;
  try {
    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function cacheSet(key, value, ttl = config.cacheTtl) {
  if (!ready || ttl <= 0) return;
  try {
    await client.set(key, JSON.stringify(value), 'EX', ttl);
  } catch {
    /* 忽略缓存写入失败 */
  }
}

export async function cacheDel(...keys) {
  if (!ready) return;
  try {
    if (keys.length) await client.del(...keys);
  } catch {
    /* ignore */
  }
}
