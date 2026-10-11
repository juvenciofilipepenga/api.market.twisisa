import type { OrderStatus } from "../generated/prisma/client.js";

// Em vez de 12 filtros de estado, o admin vê 3 separadores. É aqui que se decide em qual cai cada estado.
export type OrderBucket = "action" | "ongoing" | "done";

export const ORDER_BUCKETS: Record<OrderBucket, readonly OrderStatus[]> = {
  // Esperam pelo admin: comprovativo por confirmar, paga por preparar, pedido de cancelamento, reembolso por fazer.
  action: ["PAYMENT_REVIEW", "PAID", "CANCELLATION_REQUESTED", "REFUND_PENDING"],
  // Em andamento: à espera do cliente ou já em preparação/entrega.
  ongoing: ["PENDING_PAYMENT", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY"],
  // Fechadas.
  done: ["DELIVERED", "CANCELLED", "REFUNDED"]
};

export const bucketOf = (status: OrderStatus): OrderBucket =>
  (Object.keys(ORDER_BUCKETS) as OrderBucket[]).find((bucket) => ORDER_BUCKETS[bucket].includes(status)) ?? "done";
