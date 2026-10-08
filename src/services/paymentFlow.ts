import { OrderStatus, PaymentStatus, Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "./audit.js";
import { ensureInvoice } from "./invoice.js";
import { notifyAdmins, notifyUser } from "./notifications.js";
import { notifyReferralCompletedIfFirst } from "./referrals.js";
import { getPayment, type ZpPayment } from "./zumbopay.js";

// Núcleo do pagamento. Há UMA só porta para um pagamento passar a "pago": settlePayment().
// É chamada pelo polling do ecrã de espera, pelo webhook e pelo regresso do cartão — e em TODOS os casos o estado
// é lido do ZumboPay (GET /payments/{ref}), nunca do que o cliente ou o webhook afirmam. Assim não há celebração
// antes de o dinheiro estar confirmado, e o valor/moeda são sempre cruzados com a encomenda.

export type FailureKind = "WRONG_PIN" | "INSUFFICIENT_FUNDS" | "CANCELLED" | "TIMEOUT" | "AMOUNT_MISMATCH" | "UNAVAILABLE" | "UNKNOWN";
export type PaymentUiState = "pending" | "success" | "failed";

export const finalSuccess: PaymentStatus[] = [PaymentStatus.SUCCESS, PaymentStatus.PAYMENT_CONFIRMED];
const failedStates: PaymentStatus[] = [PaymentStatus.FAILED, PaymentStatus.TIMEOUT, PaymentStatus.CANCELLED, PaymentStatus.PAYMENT_REJECTED];
const payableOrderStates: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW];

export function classifyFailure(code?: string | null, description?: string | null): FailureKind {
  const text = `${code ?? ""} ${description ?? ""}`.toLowerCase();
  if (/pin|senha|password|credential|passcode|autentic/.test(text)) return "WRONG_PIN";
  if (/insufficient|insuficient|saldo|fundos|balance|funds/.test(text)) return "INSUFFICIENT_FUNDS";
  if (/timeout|time-out|expir|no response|sem resposta/.test(text)) return "TIMEOUT";
  if (/cancel|reject|recus|declin|abort|denied/.test(text)) return "CANCELLED";
  return "UNKNOWN";
}

export type PaymentView = {
  id: string;
  orderId: string;
  method: string | null;
  amountMzn: string;
  paymentNumber: string | null;
  state: PaymentUiState;
  status: PaymentStatus;
  failureKind: FailureKind | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  invoiceId: string | null;
  checkoutUrl?: string;
};

export function uiState(status: PaymentStatus): PaymentUiState {
  if (finalSuccess.includes(status)) return "success";
  if (failedStates.includes(status)) return "failed";
  return "pending";
}

type PaymentRow = Prisma.PaymentGetPayload<object>;

export async function toView(payment: PaymentRow): Promise<PaymentView> {
  const state = uiState(payment.status);
  const invoice = state === "success" ? await prisma.invoice.findUnique({ where: { orderId: payment.orderId }, select: { id: true } }) : null;
  return {
    id: payment.id,
    orderId: payment.orderId,
    method: payment.method,
    amountMzn: payment.amountMzn.toString(),
    paymentNumber: payment.paymentNumber,
    state,
    status: payment.status,
    failureKind: state === "failed" ? ((payment.failureCode as FailureKind | null) ?? "UNKNOWN") : null,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    confirmedAt: payment.confirmedAt?.toISOString() ?? null,
    invoiceId: invoice?.id ?? null
  };
}

// Evita martelar o ZumboPay quando há vários pedidos de estado seguidos (polling + webhook).
const lastRemoteCheck = new Map<string, number>();
const MIN_REMOTE_INTERVAL_MS = 1500;

type Logger = { error: (obj: unknown, msg?: string) => void };

// reconsiderTimeout: o webhook pode chegar DEPOIS de o pagamento ter expirado do nosso lado (o cliente confirmou o PIN
// no último segundo). Nesse caso, se o ZumboPay diz "pago", o dinheiro entrou e a encomenda tem de ser paga.
export async function settlePayment(paymentId: string, log: Logger = console, opts: { reconsiderTimeout?: boolean; force?: boolean } = {}): Promise<PaymentView | null> {
  const current = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!current) return null;
  const pendingNow = uiState(current.status) === "pending";
  if (!pendingNow && !(opts.reconsiderTimeout && current.status === PaymentStatus.TIMEOUT)) return toView(current);
  if (current.provider !== "ZUMBOPAY" || !current.providerPaymentId) return toView(current);

  const now = Date.now();
  if (!opts.force && now - (lastRemoteCheck.get(current.id) ?? 0) < MIN_REMOTE_INTERVAL_MS) return toView(current);
  lastRemoteCheck.set(current.id, now);
  if (lastRemoteCheck.size > 2000) for (const key of lastRemoteCheck.keys()) { lastRemoteCheck.delete(key); break; }

  let remote: ZpPayment | null = null;
  try {
    remote = await getPayment(current.providerPaymentId);
  } catch (error) {
    // Falha de rede/5xx: NÃO é falha de pagamento. Mantém-se pendente e o próximo ciclo volta a perguntar.
    log.error(error, "zumbopay status check failed");
  }

  if (remote && !pendingNow) {
    if (remote.state === "success" && verifySuccess(current, remote) === "ok") return applySuccess(current.id, remote, log);
    return toView(current);
  }

  if (remote) {
    if (remote.state === "success") {
      const verdict = verifySuccess(current, remote);
      if (verdict === "ok") return applySuccess(current.id, remote, log);
      if (verdict === "mismatch") {
        await notifyAdmins({ type: "PAYMENT", title: "Pagamento com valor divergente", message: `O ZumboPay confirmou ${current.reference} com valor/moeda diferentes da encomenda. Verificar manualmente.`, data: { paymentId: current.id, orderId: current.orderId } }).catch((e) => log.error(e, "mismatch alert failed"));
        return applyFailure(current.id, "AMOUNT_MISMATCH", "Amount or currency mismatch", log);
      }
      // verdict === "await-pin": e-Mola sem prova de PIN → continua pendente.
    } else if (remote.state === "failed") {
      return applyFailure(current.id, classifyFailure(remote.code, remote.description), remote.description ?? remote.code ?? null, log);
    }
    if (current.expiresAt && current.expiresAt.getTime() < now) {
      return applyFailure(current.id, "TIMEOUT", "Customer did not confirm in time", log);
    }
  }
  return toView((await prisma.payment.findUnique({ where: { id: current.id } })) ?? current);
}

function verifySuccess(payment: PaymentRow, remote: ZpPayment): "ok" | "mismatch" | "await-pin" {
  if (Math.abs(remote.amount - Number(payment.amountMzn)) > 0.01) return "mismatch";
  if (remote.currency && remote.currency !== "MZN") return "mismatch";
  if (payment.method === "EMOLA" && !remote.pinConfirmed) return "await-pin";
  return "ok";
}

async function applySuccess(paymentId: string, remote: ZpPayment, log: Logger): Promise<PaymentView | null> {
  const before = await prisma.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
  if (!before) return null;
  let outcome: { applied: boolean; orderPaid: boolean };
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // Condicional: duas chamadas simultâneas (polling + webhook) só processam uma vez.
      const changed = await tx.payment.updateMany({
        where: { id: paymentId, status: { notIn: finalSuccess } },
        data: { status: PaymentStatus.SUCCESS, confirmedAt: new Date(), transactionCode: remote.reference, failureCode: null, failureMessage: null }
      });
      if (changed.count === 0) return { applied: false, orderPaid: false };
      const moved = await tx.order.updateMany({ where: { id: before.orderId, status: { in: payableOrderStates } }, data: { status: OrderStatus.PAID } });
      if (moved.count === 1) {
        await tx.orderStatusHistory.create({ data: { orderId: before.orderId, from: before.order.status, to: OrderStatus.PAID, reason: "Pagamento confirmado pelo ZumboPay" } });
      }
      return { applied: true, orderPaid: moved.count === 1 };
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Pagamento antigo confirmado tarde enquanto já existe outro activo na mesma encomenda: decide o admin (reembolso).
      await notifyAdmins({ type: "PAYMENT", title: "Pagamento em conflito", message: `O ZumboPay confirmou ${before.reference}, mas a encomenda já tem outro pagamento activo. Verificar reembolso.`, data: { paymentId, orderId: before.orderId } }).catch((e) => log.error(e, "conflict alert failed"));
      const row = await prisma.payment.findUnique({ where: { id: paymentId } });
      return row ? toView(row) : null;
    }
    throw error;
  }

  if (outcome.applied) {
    try {
      if (outcome.orderPaid) {
        await ensureInvoice(before.orderId);
        await notifyUser({ userId: before.order.userId, type: "PAYMENT", title: "Pagamento confirmado", message: "O seu pagamento foi confirmado. Já estamos a preparar a encomenda.", data: { paymentId, orderId: before.orderId } });
        await notifyAdmins({ type: "PAYMENT", title: "Venda paga", message: `A encomenda ${before.order.orderNumber} foi paga.`, data: { paymentId, orderId: before.orderId } });
        await notifyReferralCompletedIfFirst(before.order.userId, before.orderId).catch((e) => log.error(e, "referral notification failed"));
      } else {
        await notifyAdmins({ type: "PAYMENT", title: "Pagamento recebido para encomenda não pagável", message: `Pagamento ${before.reference} confirmado, mas a encomenda ${before.order.orderNumber} está em ${before.order.status}. Verificar reembolso.`, data: { paymentId, orderId: before.orderId } });
      }
      await audit({ action: "PAYMENT_SETTLED", entity: "Payment", entityId: paymentId, metadata: { state: "success", reference: remote.reference } });
    } catch (error) {
      log.error(error, "payment success side effects failed");
    }
  }
  const row = await prisma.payment.findUnique({ where: { id: paymentId } });
  return row ? toView(row) : null;
}

async function applyFailure(paymentId: string, kind: FailureKind, detail: string | null, log: Logger): Promise<PaymentView | null> {
  const status = kind === "TIMEOUT" ? PaymentStatus.TIMEOUT : kind === "CANCELLED" ? PaymentStatus.CANCELLED : PaymentStatus.FAILED;
  const changed = await prisma.payment.updateMany({
    where: { id: paymentId, status: { notIn: [...finalSuccess, ...failedStates] } },
    data: { status, failureCode: kind, failureMessage: detail?.slice(0, 250) ?? null }
  });
  const row = await prisma.payment.findUnique({ where: { id: paymentId }, include: { order: true } });
  if (!row) return null;
  if (changed.count === 1) {
    try {
      await notifyUser({ userId: row.order.userId, type: "PAYMENT", title: "Pagamento não concluído", message: "O pagamento não foi concluído. Pode tentar novamente quando quiser.", data: { paymentId, orderId: row.orderId, kind } });
      await audit({ action: "PAYMENT_SETTLED", entity: "Payment", entityId: paymentId, metadata: { state: "failed", kind } });
    } catch (error) {
      log.error(error, "payment failure side effects failed");
    }
  }
  return toView(row);
}

// O cliente desiste (ou muda de método): só cancela se o ZumboPay ainda não confirmou — se entretanto foi pago, ganha o pago.
export async function cancelPendingPayment(paymentId: string, log: Logger = console): Promise<PaymentView | null> {
  const settled = await settlePayment(paymentId, log);
  if (!settled || settled.state !== "pending") return settled;
  await prisma.payment.updateMany({
    where: { id: paymentId, status: { notIn: [...finalSuccess, ...failedStates] } },
    data: { status: PaymentStatus.CANCELLED, failureCode: "CANCELLED", failureMessage: "Cancelled by customer" }
  });
  const row = await prisma.payment.findUnique({ where: { id: paymentId } });
  return row ? toView(row) : null;
}
