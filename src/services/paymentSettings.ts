import { prisma } from "../lib/prisma.js";
import { notifyAdmins } from "./notifications.js";
import { ZumboPayError } from "./zumbopay.js";

export type OnlineStatus = "ok" | "degraded" | "disabled";
type Settings = Awaited<ReturnType<typeof getPaymentSettings>>;

export async function getPaymentSettings() {
  return prisma.paymentSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}

// "disabled" = o admin desligou o online; "degraded" = disjuntor aberto (o ZumboPay falhou várias vezes seguidas).
export function onlineStatus(s: Settings): OnlineStatus {
  if (!s.onlineEnabled) return "disabled";
  if (s.zpDegradedUntil && s.zpDegradedUntil.getTime() > Date.now()) return "degraded";
  return "ok";
}

// Dados que o cliente vê para pagar para a conta da loja. O pagamento manual só está disponível com pelo menos um destino.
export function manualDetails(s: Settings) {
  const mpesa = s.mpesaNumber ? { number: s.mpesaNumber, name: s.mpesaName } : null;
  const emola = s.emolaNumber ? { number: s.emolaNumber, name: s.emolaName } : null;
  const bank = s.bankNib ? { name: s.bankName, nib: s.bankNib, holder: s.bankHolder } : null;
  return { enabled: s.manualEnabled && Boolean(mpesa || emola || bank), mpesa, emola, bank, instructions: s.instructions };
}

// Só conta como "o ZumboPay está mal" o que NÃO é culpa do cliente: rede, resposta inválida, chave em falta,
// 5xx, 401/403 (conta/chave bloqueada) e 429. Um número inválido (422) não abre o disjuntor.
export function isProviderFailure(error: unknown): boolean {
  if (!(error instanceof ZumboPayError)) return false;
  if (error.kind === "NETWORK" || error.kind === "BAD_RESPONSE" || error.kind === "NOT_CONFIGURED") return true;
  return error.kind === "REJECTED" && (error.httpStatus >= 500 || [401, 403, 429].includes(error.httpStatus));
}

const FAILURE_WINDOW_MS = 5 * 60_000;
const TRIP_AFTER = 3;
const COOL_DOWN_MS = 10 * 60_000;

// Disjuntor: 3 falhas do ZumboPay em 5 min → 10 min a desviar para o pagamento manual. Depois, a próxima tentativa
// real volta a testar o ZumboPay ("meio aberto"). O estado vive na base de dados (a Vercel não partilha memória).
export async function recordProviderFailure(): Promise<void> {
  const s = await getPaymentSettings();
  const recent = s.zpFailureAt !== null && Date.now() - s.zpFailureAt.getTime() < FAILURE_WINDOW_MS;
  const failures = recent ? s.zpFailures + 1 : 1;
  const trips = failures >= TRIP_AFTER;
  await prisma.paymentSettings.update({
    where: { id: "main" },
    data: { zpFailures: failures, zpFailureAt: new Date(), ...(trips ? { zpDegradedUntil: new Date(Date.now() + COOL_DOWN_MS) } : {}) }
  });
  if (failures === TRIP_AFTER) {
    await notifyAdmins({ type: "PAYMENT", title: "ZumboPay indisponível", message: "O ZumboPay falhou várias vezes seguidas. Os clientes estão a ser desviados para o pagamento manual durante 10 minutos.", data: {} }).catch(() => undefined);
  }
}

export async function recordProviderSuccess(): Promise<void> {
  const s = await getPaymentSettings();
  if (s.zpFailures === 0 && !s.zpDegradedUntil) return;
  await prisma.paymentSettings.update({ where: { id: "main" }, data: { zpFailures: 0, zpFailureAt: null, zpDegradedUntil: null } });
}
