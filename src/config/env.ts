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
    ZUMBOPAY_WEBHOOK_SECRET: z.string().min(1).optional(),
    // Carteiras ZumboPay (UUID) por método — GET /wallets na API ZumboPay lista-as. Sem a carteira, o método fica indisponível.
    ZUMBOPAY_WALLET_MPESA: z.string().min(1).optional(),
    ZUMBOPAY_WALLET_EMOLA: z.string().min(1).optional(),
    ZUMBOPAY_WALLET_CARD: z.string().min(1).optional(),
    // Segundos que o cliente tem para confirmar o PIN no telemóvel antes de o pagamento expirar.
    PAYMENT_CONFIRM_WINDOW_SECONDS: z.coerce.number().int().min(60).max(900).default(180),
    // Pagamento manual: tempo (s) que o cliente tem para pagar a partir de "Enviar pedido". Passado isto, o pedido expira sozinho.
    MANUAL_PAYMENT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(1800).default(300),
    // Simulador de pagamentos para desenvolvimento/demonstração (nunca em produção).
    ZUMBOPAY_MOCK: z.string().optional().transform((v) => v === "true"),
    // URL pública do frontend (para onde o cartão regressa após o 3DS). Por omissão, a primeira origem CORS.
    FRONTEND_URL: z.string().url().optional(),
    GROQ_API_KEY: z.string().min(1).optional(),
    GROQ_MODEL: z.string().min(1).default("llama-3.3-70b-versatile"),
    GROQ_API_BASE_URL: z.string().url().default("https://api.groq.com/openai/v1"),
    // URL pública onde este backend fica acessível; usado para construir o webhook/return URL enviados ao ZumboPay.
    APP_PUBLIC_URL: z.string().url().optional()
  })
  .superRefine((value, ctx) => {
    if (value.ZUMBOPAY_MOCK && value.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["ZUMBOPAY_MOCK"], message: "ZUMBOPAY_MOCK must not be enabled in production" });
    }
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
// CORS_ORIGIN aceita uma lista separada por vírgulas (ex.: domínio com e sem www).
export const corsOrigins = env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean);
export const cloudinaryConfigured = Boolean(
  env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
);
export const ZUMBOPAY_DEFAULT_BASE_URL = "https://zumbopay.com/api/public/v1";
export const zumboPayMock = env.ZUMBOPAY_MOCK === true && env.NODE_ENV !== "production";
// Real: chave configurada. Simulado: só fora de produção. Qualquer um dos dois permite o fluxo completo.
export const zumboPayConfigured = zumboPayMock || Boolean(env.ZUMBOPAY_ENABLED && env.ZUMBOPAY_API_KEY);
export const frontendUrl = env.FRONTEND_URL ?? corsOrigins[0] ?? "http://localhost:5173";
export const groqConfigured = Boolean(env.GROQ_API_KEY);
