const session = require("express-session");
// connect-redis@7 exports the class as `default` in CJS. v8+ switched to a
// named export; this line works for v7 and can be simplified after upgrade.
const RedisStore = require("connect-redis").default;
const Redis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://redis:6379";
const SESSION_SECRET = process.env.SESSION_SECRET || "poc-dev-secret-change-me";

function buildSessionMiddleware() {
  const redisClient = new Redis(REDIS_URL);
  const store = new RedisStore({ client: redisClient, prefix: "sess:" });

  return session({
    store,
    name: "inaiera_sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8h
    },
  });
}

module.exports = { buildSessionMiddleware };
