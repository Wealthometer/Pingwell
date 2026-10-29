// Runs before every test file. Points the app at a throwaway database and Redis DB.
process.env.NODE_ENV = "test"
process.env.LOG_LEVEL = "silent"
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pingwell_test"
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15"
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-test"
process.env.ALLOW_PRIVATE_TARGETS = "true" // tests run targets on localhost
process.env.MIN_INTERVAL_SECONDS = "10"
process.env.PUBLIC_APP_URL = "http://pingwell.test"
process.env.RATE_LIMIT = "false" // covered separately in rate-limit.test.ts
