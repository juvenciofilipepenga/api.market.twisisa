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
    MANUAL_PAYMENT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(1800).default(1800),
    // Prazo (s) para pagar uma encomenda, contado desde que o pedido é enviado. Passado isto (mais uma pequena tolerância),
    // a encomenda expira, o stock volta e o cliente já não a consegue pagar.
    ORDER_PAYMENT_WINDOW_SECONDS: z.coerce.number().int().min(300).max(3600).default(1800),
    // Prazo máximo de entrega, em dias, contado desde a confirmação do pagamento (mostrado ao cliente).
    DELIVERY_MAX_DAYS: z.coerce.number().int().min(1).max(60).default(15),
    // Simulador de pagamentos para desenvolvimento/demonstração (nunca em produção).
    ZUMBOPAY_MOCK: z.string().optional().transform((v) => v === "true"),
    // URL pública do frontend (para onde o cartão regressa após o 3DS). Por omissão, a primeira origem CORS.
    FRONTEND_URL: z.string().url().optional(),
    // Recuperação de conta por email (EmailJS). As 4 primeiras variáveis são TODAS necessárias para enviar emails;
    // EMAILJS_TEMPLATE_ID_CHANGED é opcional (aviso "a sua palavra-passe foi alterada").
    EMAILJS_SERVICE_ID: z.string().min(1).optional(),
    EMAILJS_TEMPLATE_ID: z.string().min(1).optional(),
    EMAILJS_PUBLIC_KEY: z.string().min(1).optional(),
    EMAILJS_PRIVATE_KEY: z.string().min(1).optional(),
    EMAILJS_TEMPLATE_ID_CHANGED: z.string().min(1).optional(),
    // Minutos de validade do link de recuperação.
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
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
    // Configuração a meio (ex.: falta a chave privada) falha no arranque, em vez de só se descobrir quando um cliente pede o email.
    const emailjsSet = [value.EMAILJS_SERVICE_ID, value.EMAILJS_TEMPLATE_ID, value.EMAILJS_PUBLIC_KEY, value.EMAILJS_PRIVATE_KEY].filter(Boolean).length;
    if (emailjsSet > 0 && emailjsSet < 4) {
      ctx.addIssue({ code: "custom", path: ["EMAILJS_SERVICE_ID"], message: "EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, EMAILJS_PUBLIC_KEY and EMAILJS_PRIVATE_KEY must be set together" });
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
export interface EmailJsConfig { serviceId: string; templateReset: string; templateChanged?: string; publicKey: string; privateKey: string }
export const emailjsConfig: EmailJsConfig | null =
  env.EMAILJS_SERVICE_ID && env.EMAILJS_TEMPLATE_ID && env.EMAILJS_PUBLIC_KEY && env.EMAILJS_PRIVATE_KEY
    ? { serviceId: env.EMAILJS_SERVICE_ID, templateReset: env.EMAILJS_TEMPLATE_ID, templateChanged: env.EMAILJS_TEMPLATE_ID_CHANGED, publicKey: env.EMAILJS_PUBLIC_KEY, privateKey: env.EMAILJS_PRIVATE_KEY }
    : null;
export const groqConfigured = Boolean(env.GROQ_API_KEY);
