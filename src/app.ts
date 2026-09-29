import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { env } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes } from "./routes/auth.js";
import { userRoutes } from "./routes/users.js";
import { productRoutes } from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";
import { notificationRoutes } from "./routes/notifications.js";
import { paymentRoutes } from "./routes/payments.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { mediaRoutes } from "./routes/media.js";
import { referralRoutes } from "./routes/referrals.js";
import { chatRoutes } from "./routes/chat.js";

export function buildApp() {
  // Em produção corre atrás do proxy da plataforma (Render/Railway/Fly); confiar nele é o que
  // permite ao rate-limit e ao audit ver o IP real do cliente em vez do IP do proxy.
  const app = Fastify({ logger: env.NODE_ENV !== "test", trustProxy: env.NODE_ENV === "production" });
  app.register(helmet);
  app.register(cors, { origin: env.CORS_ORIGIN, credentials: true });
  app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW });
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 5 } });
  app.register(async (api) => {
    await healthRoutes(api);
    await authRoutes(api);
    await userRoutes(api);
    await productRoutes(api);
    await orderRoutes(api);
    await notificationRoutes(api);
    await paymentRoutes(api);
    await invoiceRoutes(api);
    await mediaRoutes(api);
    await referralRoutes(api);
    await chatRoutes(api);
  }, { prefix: "/api/v1" });
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    const statusCode = typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : 500;
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "INTERNAL_SERVER_ERROR" : "REQUEST_ERROR" });
  });
  return app;
}

export default buildApp();
