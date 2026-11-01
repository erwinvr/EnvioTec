// Fixed-window counters and short locks in Redis, shared by every backend
// replica (A2, A5). Keys never contain personal data: callers pass hashes.

export function createRateLimiter(redis, { prefix = 'enviotec' } = {}) {
  const key = (name) => `${prefix}:${name}`;

  return {
    // Counts one hit. EXPIRE NX on every call (not only the first) makes sure
    // the key always ends up with a TTL even if a process died between both
    // commands.
    async hit(name, { limit, windowSeconds }) {
      const fullKey = key(name);
      const count = await redis.incr(fullKey);
      await redis.expire(fullKey, windowSeconds, 'NX');
      if (count <= limit) return { allowed: true, count };
      const ttl = await redis.pttl(fullKey);
      return { allowed: false, count, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
    },

    async count(name) {
      return Number(await redis.get(key(name))) || 0;
    },

    async reset(name) {
      await redis.del(key(name));
    },

    // Mutual exclusion for one key (for example, one login attempt at a time
    // per account). Returns a release function, or null if already taken.
    async acquire(name, ttlMs) {
      const fullKey = key(name);
      const taken = await redis.set(fullKey, '1', 'PX', ttlMs, 'NX');
      if (taken !== 'OK') return null;
      return () => redis.del(fullKey).then(() => {}, () => {});
    },

    async setValue(name, value, ttlSeconds) {
      await redis.set(key(name), value, 'EX', ttlSeconds);
    },

    async getValue(name) {
      return redis.get(key(name));
    },
  };
}
