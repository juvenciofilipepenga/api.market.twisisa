import { OrderStatus, PaymentStatus, type Prisma } from "../generated/prisma/client.js";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { notifyUser } from "./notifications.js";

// Motivo gravado em Order.cancellationReason quando o cliente não pagou a tempo.
// É o que separa "expirada" de "cancelada pelo cliente" nos separadores de encomendas.
export const EXPIRY_REASON = "PAYMENT_EXPIRED";

// Tolerância depois do prazo: quem pagou no último minuto ainda consegue carregar em "Já paguei".
// É a mesma constante que o pagamento manual usa (MANUAL_CLAIM_GRACE_MS em paymentFlow.ts).
export const EXPIRY_GRACE_MS = 2 * 60_000;

export const paymentWindowMs = (): number => env.ORDER_PAYMENT_WINDOW_SECONDS * 1000;

/** Fim do prazo de pagamento: o relógio começa quando o pedido é enviado (createdAt), não quando se abre o ecrã de pagamento. */
export const paymentDeadline = (createdAt: Date): Date => new Date(createdAt.getTime() + paymentWindowMs());

/** Prazo máximo de entrega, contado desde a confirmação do pagamento (ou desde o pedido, se não houver data). */
export const deliveryDeadline = (from: Date): Date => new Date(from.getTime() + env.DELIVERY_MAX_DAYS * 86_400_000);

type Tx = Prisma.TransactionClient;

// Devolve o stock de uma encomenda. Mesma regra do cancelamento em routes/orders.ts:
// com variante, o stock vive na variante; sem variante, no produto. Produto apagado depois da encomenda: nada a repor.
async function restock(tx: Tx, items: Array<{ productId: string | null; variantId: string | null; quantity: number }>): Promise<void> {
  for (const item of items) {
    if (!item.productId) continue;
    if (item.variantId) {
      await tx.productVariant.update({ where: { id: item.variantId }, data: { stock: { increment: item.quantity } } });
    } else {
      await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
    }
  }
}

/**
 * Expira as encomendas que ficaram a aguardar pagamento além do prazo (+ tolerância).
 * - Só mexe em PENDING_PAYMENT: quem já carregou em "Já paguei" (PAYMENT_REVIEW) fica à espera do admin, nunca expira.
 * - Cada encomenda é reclamada com uma transição condicional ao estado: dois processos em simultâneo não repõem o stock duas vezes.
 * - `scope` limita a um cliente ou a uma encomenda (usado nas leituras); sem scope varre tudo (usado pelo temporizador do servidor).
 */
export async function expireStaleOrders(scope: { userId?: string; orderId?: string } = {}): Promise<number> {
  const cutoff = new Date(Date.now() - paymentWindowMs() - EXPIRY_GRACE_MS);
  const stale = await prisma.order.findMany({
    where: { status: OrderStatus.PENDING_PAYMENT, createdAt: { lt: cutoff }, ...(scope.userId ? { userId: scope.userId } : {}), ...(scope.orderId ? { id: scope.orderId } : {}) },
    select: { id: true, userId: true, orderNumber: true, items: { select: { productId: true, variantId: true, quantity: true } } },
    take: 100
  });

  let expired = 0;
  for (const order of stale) {
    const done = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.CANCELLED, cancellationReason: EXPIRY_REASON, cancelledAt: new Date() }
      });
      if (claimed.count === 0) return false; // outro processo foi mais rápido
      await restock(tx, order.items);
      await tx.orderStatusHistory.create({ data: { orderId: order.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.CANCELLED, reason: "Prazo de pagamento expirado" } });
      // Pagamentos ainda "a meio" ficam encerrados; o webhook tardio do ZumboPay continua a ser reconsiderado em paymentFlow.
      await tx.payment.updateMany({
        where: { orderId: order.id, status: { in: [PaymentStatus.INITIATED, PaymentStatus.PENDING_CONFIRMATION] } },
        data: { status: PaymentStatus.TIMEOUT, failureCode: "TIMEOUT", failureMessage: "Order payment window expired" }
      });
      return true;
    });
    if (!done) continue;
    expired += 1;
    try {
      await notifyUser({ userId: order.userId, type: "PAYMENT", title: "Encomenda expirada", message: `O prazo para pagar a encomenda ${order.orderNumber} terminou e a reserva foi libertada.`, data: { orderId: order.id } });
    } catch {
      // a notificação nunca desfaz a expiração
    }
  }
  return expired;
}
