import { randomUUID } from "node:crypto";
import { env, zumboPayMock, ZUMBOPAY_DEFAULT_BASE_URL } from "../config/env.js";

// Cliente da API pública ZumboPay (https://zumbopay.com/api/public/v1), baseado no plugin oficial:
//   POST /charges            → STK push directo (M-Pesa / e-Mola). Devolve data.reference + data.status.
//   POST /payments           → ligação de pagamento hospedada (cartão, 3DS). Devolve checkout_url.
//   GET  /payments/{ref}     → estado AUTORITATIVO. É a única fonte de verdade para dar um pagamento como pago.
export type ZpMethod = "MPESA" | "EMOLA" | "CARD";
export type ZpState = "success" | "pending" | "failed";

export type ZpCharge = { reference: string; state: ZpState; description?: string; code?: string };
export type ZpPayment = {
  reference: string;
  state: ZpState;
  amount: number;
  currency: string;
  channel: string;
  description?: string;
  code?: string;
  /** Prova de que o cliente introduziu o PIN (e-Mola). Ver pinConfirmed(). */
  pinConfirmed: boolean;
};
export class ZumboPayError extends Error {
  constructor(public readonly kind: "NOT_CONFIGURED" | "NETWORK" | "REJECTED" | "BAD_RESPONSE", message: string, public readonly httpStatus = 0) {
    super(message);
  }
}

export function walletFor(method: ZpMethod): string | undefined {
  if (zumboPayMock) return `mock-wallet-${method.toLowerCase()}`;
  return { MPESA: env.ZUMBOPAY_WALLET_MPESA, EMOLA: env.ZUMBOPAY_WALLET_EMOLA, CARD: env.ZUMBOPAY_WALLET_CARD }[method];
}

export function normalizeState(raw: unknown): ZpState {
  const s = String(raw ?? "").toLowerCase();
  if (["success", "completed", "paid"].includes(s)) return "success";
  if (["failed", "cancelled", "canceled", "expired", "rejected", "declined"].includes(s)) return "failed";
  return "pending";
}

// Regra do plugin oficial: e-Mola só conta como pago com prova de PIN. Sem prova, continua pendente.
export function pinConfirmed(data: Record<string, unknown>): boolean {
  if (data.pin_verified || data.pin_confirmed || data.pin_confirmed_at) return true;
  const provider = String(data.provider_status ?? "").toUpperCase();
  if (["PIN_CONFIRMED", "COMPLETED_WITH_PIN", "AUTHORIZED_BY_PIN", "SUCCESS"].includes(provider)) return true;
  const meta = data.metadata;
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    if (m.pin_verified || m.emola_pin_ok) return true;
  }
  return false;
}

function baseUrl(): string {
  return (env.ZUMBOPAY_API_BASE_URL ?? ZUMBOPAY_DEFAULT_BASE_URL).replace(/\/$/, "");
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!env.ZUMBOPAY_API_KEY) throw new ZumboPayError("NOT_CONFIGURED", "ZUMBOPAY_NOT_CONFIGURED");
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ZUMBOPAY_API_KEY.replace(/\s+/g, "")}`,
        "X-ZumboPay-Client": "twisisa-market/1.0",
        // Mesma chave em retentativas = o ZumboPay não duplica a cobrança.
        ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (error) {
    throw new ZumboPayError("NETWORK", error instanceof Error ? error.message : "network error");
  }
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!json || typeof json !== "object") throw new ZumboPayError("BAD_RESPONSE", `HTTP ${response.status}`, response.status);
  if (!response.ok && !(json.data && typeof json.data === "object")) {
    const err = json.error;
    const message = typeof err === "string" ? err : (typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : `HTTP ${response.status}`);
    throw new ZumboPayError("REJECTED", message, response.status);
  }
  return json;
}

const asData = (json: Record<string, unknown>): Record<string, unknown> =>
  (json.data && typeof json.data === "object" ? json.data : json.payment && typeof json.payment === "object" ? json.payment : json) as Record<string, unknown>;

export async function createCharge(input: { method: "MPESA" | "EMOLA"; walletId: string; amountMzn: number; msisdn: string; customerName: string; sourceId: string }): Promise<ZpCharge> {
  if (zumboPayMock) return mock.createCharge(input);
  const data = asData(await call("POST", "/charges", {
    wallet_id: input.walletId, amount: input.amountMzn, msisdn: input.msisdn, customer_name: input.customerName, source_id: input.sourceId
  }));
  if (typeof data.reference !== "string" || !data.reference) throw new ZumboPayError("BAD_RESPONSE", "missing reference");
  return { reference: data.reference, state: normalizeState(data.status), description: typeof data.description === "string" ? data.description : undefined, code: typeof data.code === "string" ? data.code : undefined };
}

export async function createCardCheckout(input: { walletId: string; amountMzn: number; title: string; sourceId: string; returnUrl: string }): Promise<{ reference: string; checkoutUrl: string }> {
  if (zumboPayMock) return mock.createCardCheckout(input);
  const json = await call("POST", "/payments", {
    type: "link", title: input.title, amount: input.amountMzn, currency: "MZN", channels: ["card"], wallet_id: input.walletId,
    description: input.title, source: "twisisa-market", source_id: input.sourceId, return_url: input.returnUrl, callback_url: input.returnUrl
  });
  const data = asData(json);
  const checkoutUrl = (json.checkout_url ?? data.checkout_url) as unknown;
  const reference = (data.reference ?? json.reference) as unknown;
  if (typeof checkoutUrl !== "string" || typeof reference !== "string") throw new ZumboPayError("BAD_RESPONSE", "missing checkout_url");
  return { reference, checkoutUrl };
}

export async function getPayment(reference: string): Promise<ZpPayment> {
  if (zumboPayMock) return mock.getPayment(reference);
  const data = asData(await call("GET", `/payments/${encodeURIComponent(reference)}`));
  return {
    reference,
    state: normalizeState(data.status),
    amount: Number(data.amount ?? 0),
    currency: String(data.currency ?? "").toUpperCase(),
    channel: String(data.channel ?? data.method ?? "").toLowerCase(),
    description: typeof data.description === "string" ? data.description : undefined,
    code: typeof data.code === "string" ? data.code : undefined,
    pinConfirmed: pinConfirmed(data)
  };
}

// ─── Simulador (só ZUMBOPAY_MOCK=true fora de produção) ───────────────────────────────────────────────
// Permite ver o fluxo inteiro sem dinheiro real. O último dígito do número escolhe o desfecho:
//   0 → PIN errado · 1 → saldo insuficiente · 2 → cancelado pelo cliente · 3 → nunca responde (expira) · resto → sucesso (~7 s)
const MOCK_DELAY_MS = 7_000;
const mockStore = new Map<string, { at: number; amount: number; channel: string; scenario: string }>();
const mock = {
  async createCharge(input: { method: "MPESA" | "EMOLA"; amountMzn: number; msisdn: string }): Promise<ZpCharge> {
    const reference = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    mockStore.set(reference, { at: Date.now(), amount: input.amountMzn, channel: input.method.toLowerCase(), scenario: input.msisdn.slice(-1) });
    return { reference, state: "pending" };
  },
  async createCardCheckout(input: { amountMzn: number; returnUrl: string }): Promise<{ reference: string; checkoutUrl: string }> {
    const reference = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    mockStore.set(reference, { at: Date.now(), amount: input.amountMzn, channel: "card", scenario: "9" });
    return { reference, checkoutUrl: input.returnUrl };
  },
  async getPayment(reference: string): Promise<ZpPayment> {
    const entry = mockStore.get(reference);
    if (!entry) throw new ZumboPayError("REJECTED", "unknown reference", 404);
    const base = { reference, amount: entry.amount, currency: "MZN", channel: entry.channel };
    if (Date.now() - entry.at < MOCK_DELAY_MS) return { ...base, state: "pending", pinConfirmed: false };
    switch (entry.scenario) {
      case "0": return { ...base, state: "failed", description: "Incorrect PIN", code: "INVALID_PIN", pinConfirmed: false };
      case "1": return { ...base, state: "failed", description: "Insufficient funds", code: "INSUFFICIENT_FUNDS", pinConfirmed: false };
      case "2": return { ...base, state: "failed", description: "Transaction cancelled by customer", code: "CANCELLED", pinConfirmed: false };
      case "3": return { ...base, state: "pending", pinConfirmed: false };
      default: return { ...base, state: "success", pinConfirmed: true };
    }
  }
};
