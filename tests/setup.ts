process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://test:test@localhost:5432/test";
process.env.JWT_SECRET ??= "test-secret-that-is-long-enough-for-the-application";
process.env.CORS_ORIGIN ??= "http://localhost:5173";
process.env.ZUMBOPAY_WEBHOOK_SECRET ??= "test-webhook-secret";
