import { describe, expect, it } from "vitest";
import { OrderStatus, PaymentStatus } from "../src/generated/prisma/client.js";
import { EXPIRY_REASON, paymentDeadline } from "../src/services/orderExpiry.js";
import { classifyOrder } from "../src/services/orderTabs.js";

const base = { cancellationReason: null, paymentStatuses: [] as PaymentStatus[] };

describe("classifyOrder (separadores de Meus pedidos)", () => {
  it("pago e confirmado vai para a carteira, mesmo que ainda não tenha sido entregue", () => {
    for (const status of [OrderStatus.PAID, OrderStatus.PROCESSING, OrderStatus.SHIPPED, OrderStatus.DELIVERED]) {
      expect(classifyOrder({ ...base, status, paymentStatuses: [PaymentStatus.PAYMENT_CONFIRMED] })).toBe("wallet");
    }
    expect(classifyOrder({ ...base, status: OrderStatus.PAID, paymentStatuses: [PaymentStatus.SUCCESS] })).toBe("wallet");
  });

  it("à espera de pagamento ou do admin é P2P", () => {
    expect(classifyOrder({ ...base, status: OrderStatus.PENDING_PAYMENT })).toBe("p2p");
    expect(classifyOrder({ ...base, status: OrderStatus.PAYMENT_REVIEW, paymentStatuses: [PaymentStatus.PROOF_SUBMITTED] })).toBe("p2p");
  });

  it("expirada (e só expirada) é P2P; cancelada pelo cliente fica fora dos separadores", () => {
    expect(classifyOrder({ ...base, status: OrderStatus.CANCELLED, cancellationReason: EXPIRY_REASON })).toBe("p2p");
    expect(classifyOrder({ ...base, status: OrderStatus.CANCELLED, cancellationReason: "mudei de ideias" })).toBe("other");
  });

  it("comprovativo recusado sem outro em curso é Recusadas; se reenviou, volta a P2P", () => {
    expect(classifyOrder({ ...base, status: OrderStatus.PENDING_PAYMENT, paymentStatuses: [PaymentStatus.PAYMENT_REJECTED] })).toBe("refused");
    expect(classifyOrder({ ...base, status: OrderStatus.CANCELLED, cancellationReason: EXPIRY_REASON, paymentStatuses: [PaymentStatus.PAYMENT_REJECTED] })).toBe("refused");
    expect(classifyOrder({ ...base, status: OrderStatus.PAYMENT_REVIEW, paymentStatuses: [PaymentStatus.PAYMENT_REJECTED, PaymentStatus.PROOF_SUBMITTED] })).toBe("p2p");
  });

  it("recusado e depois confirmado é carteira", () => {
    expect(classifyOrder({ ...base, status: OrderStatus.PAID, paymentStatuses: [PaymentStatus.PAYMENT_REJECTED, PaymentStatus.PAYMENT_CONFIRMED] })).toBe("wallet");
  });
});

describe("paymentDeadline", () => {
  it("conta desde o pedido, não desde a abertura do ecrã de pagamento (por defeito 30 min)", () => {
    const created = new Date("2026-10-12T06:00:00Z");
    expect(paymentDeadline(created).toISOString()).toBe("2026-10-12T06:30:00.000Z");
  });
});
