import { OrderStatus, PaymentStatus, type Prisma } from "../generated/prisma/client.js";
import { EXPIRY_REASON } from "./orderExpiry.js";

// Os separadores de "Meus pedidos" (cliente):
//   wallet  = já pago e confirmado (pelo admin, ou automaticamente pelo ZumboPay)
//   p2p     = em espera (a pagar / à espera do admin) + expiradas
//   refused = o admin recusou o comprovativo e não há outro em curso
//   all     = tudo
// Nota: "confirmado" não quer dizer "entregue" — uma encomenda na carteira pode ainda estar em preparação ou a caminho.
export const ORDER_TABS = ["all", "wallet", "p2p", "refused"] as const;
export type OrderTab = (typeof ORDER_TABS)[number];
export type OrderPhase = "wallet" | "p2p" | "refused" | "other";

const PAID: PaymentStatus[] = [PaymentStatus.PAYMENT_CONFIRMED, PaymentStatus.SUCCESS];
const IN_REVIEW: PaymentStatus[] = [PaymentStatus.PROOF_SUBMITTED, PaymentStatus.UNDER_REVIEW];

const hasPaid: Prisma.OrderWhereInput = { payments: { some: { status: { in: PAID } } } };
const hasReview: Prisma.OrderWhereInput = { payments: { some: { status: { in: IN_REVIEW } } } };
const hasRejected: Prisma.OrderWhereInput = { payments: { some: { status: PaymentStatus.PAYMENT_REJECTED } } };

const refusedWhere: Prisma.OrderWhereInput = {
  AND: [{ status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.CANCELLED] } }, hasRejected, { NOT: hasPaid }, { NOT: hasReview }]
};

export function tabWhere(tab: OrderTab): Prisma.OrderWhereInput {
  switch (tab) {
    case "wallet":
      return hasPaid;
    case "refused":
      return refusedWhere;
    case "p2p":
      return {
        AND: [
          { NOT: hasPaid },
          { NOT: refusedWhere },
          { OR: [{ status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW] } }, { status: OrderStatus.CANCELLED, cancellationReason: EXPIRY_REASON }] }
        ]
      };
    default:
      return {};
  }
}

/** A mesma regra de `tabWhere`, para uma encomenda já carregada (a lista "Todos" mostra a fase de cada uma). Manter as duas em sincronia. */
export function classifyOrder(input: { status: OrderStatus; cancellationReason: string | null; paymentStatuses: PaymentStatus[] }): OrderPhase {
  const { status, cancellationReason, paymentStatuses } = input;
  if (paymentStatuses.some((s) => PAID.includes(s))) return "wallet";
  const refused = (status === OrderStatus.PENDING_PAYMENT || status === OrderStatus.CANCELLED)
    && paymentStatuses.includes(PaymentStatus.PAYMENT_REJECTED)
    && !paymentStatuses.some((s) => IN_REVIEW.includes(s));
  if (refused) return "refused";
  if (status === OrderStatus.PENDING_PAYMENT || status === OrderStatus.PAYMENT_REVIEW) return "p2p";
  if (status === OrderStatus.CANCELLED && cancellationReason === EXPIRY_REASON) return "p2p";
  return "other";
}
