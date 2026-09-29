import "dotenv/config";
import { z } from "zod";

// Valores de exemplo que nunca devem chegar a um ambiente real.
const PLACEHOLDER_SECRET = /replace-with|change-?me|your[-_ ]?secret/i;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: z.string().min(1).default("0.0.0.0"),
    DATABASE_URL: z.string().min(1),
    DIRECT_URL: z.string().min(1).optional(),
    JWT_SECRET: z
      .string()
      .min(32)
      .refine((value) => !PLACEHOLDER_SECRET.test(value), "JWT_SECRET must not be a placeholder value"),
    JWT_EXPIRES_IN: z.string().min(1).default("15m"),
    CORS_ORIGIN: z.string().min(1).default("http://localhost:5173"),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
    SHIPPING_FLAT_MZN: z.coerce.number().nonnegative().max(100000).default(0),
    CLOUDINARY_CLOUD_NAME: z.string().min(1).optional(),
    CLOUDINARY_API_KEY: z.string().min(1).optional(),
    CLOUDINARY_API_SECRET: z.string().min(1).optional(),
    ZUMBOPAY_ENABLED: z.string().optional().transform((v) => v === "true"),
    ZUMBOPAY_API_BASE_URL: z.string().url().optional(),
    ZUMBOPAY_API_KEY: z.string().min(1).optional(),
    ZUMBOPAY_MERCHANT_ID: z.string().min(1).optional(),
    ZUMBOPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    ZUMBOPAY_PAYMENT_PATH: z.string().min(1).default("/api/v1/payments"),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
    GROQ_API_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    // URL pública onde este backend fica acessível; usado para construir o webhook/return URL enviados ao ZumboPay.
    APP_PUBLIC_URL: z.string().url().optional()
  })
  .superRefine((value, ctx) => {
    if (value.ZUMBOPAY_ENABLED && !value.ZUMBOPAY_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["ZUMBOPAY_WEBHOOK_SECRET"], message: "Required when ZUMBOPAY_ENABLED=true" });
    }
  });

// Variáveis vazias (ex.: "CLOUDINARY_API_KEY=" copiado do .env.example) contam como não definidas.
export function parseEnv(source: NodeJS.ProcessEnv) {
  const cleaned = Object.fromEntries(Object.entries(source).map(([key, value]) => [key, value === "" ? undefined : value]));
  return schema.parse(cleaned);
}

export const env = parseEnv(process.env);
export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);
export const zumboPayConfigured = Boolean(
  env.ZUMBOPAY_ENABLED && env.ZUMBOPAY_API_BASE_URL && env.ZUMBOPAY_API_KEY
);
export const groqConfigured = Boolean(env.GROQ_API_KEY);
