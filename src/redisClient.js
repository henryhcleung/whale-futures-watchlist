const redis = require('redis');

let redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: REDIS_URL environment variable is not set in production.');
    process.exit(1);
  } else {
    redisUrl = 'redis://localhost:6379';
    console.info('REDIS_URL not set, falling back to localhost Redis for development.');
  }
}

console.info('Connecting to Redis with URL:', redisUrl);

const client = redis.createClient({
  url: redisUrl,
});

client.on('error', (err) => {
  console.error('Redis Client Error:', err);
});

(async () => {
  try {
    await client.connect();
    console.info('Connected to Redis at:', redisUrl);
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
    process.exit(1);
  }
})();

module.exports = client;