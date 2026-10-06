import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { OrderStatus, PaymentStatus, Prisma, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { randomReference } from "../lib/auth.js";
import { isAdmin, requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { ensureInvoice } from "../services/invoice.js";
import { notifyAdmins, notifyUser } from "../services/notifications.js";
import { getPaymentProvider } from "../services/payment.js";
import { notifyReferralCompletedIfFirst } from "../services/referrals.js";

// Rede moçambicana pelo prefixo do número (sem indicativo ou com +258): M-Pesa 84/85, e-Mola 86/87.
const mpesaPhone = /^(258)?8[45]\d{7}$/;
const emolaPhone = /^(258)?8[67]\d{7}$/;

const initiateSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("ZUMBOPAY"), method: z.string().trim().min(2).max(40) }),
  z.discriminatedUnion("method", [
    z.object({ provider: z.literal("MANUAL"), method: z.literal("MPESA"), paymentNumber: z.string().trim().regex(mpesaPhone, "Número M-Pesa inválido (deve começar por 84 ou 85)") }),
    z.object({ provider: z.literal("MANUAL"), method: z.literal("EMOLA"), paymentNumber: z.string().trim().regex(emolaPhone, "Número e-Mola inválido (deve começar por 86 ou 87)") }),
    // Cartão Visa: fluxo manual/offline (ex.: POS na entrega). O backend nunca recebe nem guarda o número do cartão.
    z.object({ provider: z.literal("MANUAL"), method: z.literal("CARD") })
  ])
]);

const activePaymentStates: PaymentStatus[] = [
  PaymentStatus.INITIATED, PaymentStatus.AUTHENTICATING, PaymentStatus.PENDING_CONFIRMATION,
  PaymentStatus.PAYMENT_PENDING, PaymentStatus.PROOF_SUBMITTED, PaymentStatus.UNDER_REVIEW,
  PaymentStatus.SUCCESS, PaymentStatus.PAYMENT_CONFIRMED
];
const webhookSchema = z.object({ status: z.enum(["SUCCESS", "FAILED", "TIMEOUT", "PENDING_CONFIRMATION"]), transactionCode: z.string().max(120).optional(), providerPaymentId: z.string().max(120).optional(), failureCode: z.string().max(80).optional(), failureMessage: z.string().max(250).optional() });

const finalPaymentStates: PaymentStatus[] = [PaymentStatus.SUCCESS, PaymentStatus.PAYMENT_CONFIRMED];
// Estados em que o cliente pode (re)submeter comprovativo de um pagamento manual.
const proofAllowedStates: PaymentStatus[] = [
  PaymentStatus.INITIATED, PaymentStatus.PENDING_CONFIRMATION, PaymentStatus.PAYMENT_PENDING,
  PaymentStatus.PROOF_SUBMITTED, PaymentStatus.PAYMENT_REJECTED
];
const payableOrderStates: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_REVIEW];

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/orders/:id/payments/initiate", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = initiateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const order = await prisma.order.findUnique({ where: { id: params.data.id }, include: { user: true, payments: true } });
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
    if (order.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    // Só se pode iniciar pagamento enquanto a encomenda aguarda pagamento (não em PAID, SHIPPED, etc.).
    if (order.status !== OrderStatus.PENDING_PAYMENT) return reply.code(409).send({ error: "ORDER_PAYMENT_NOT_ALLOWED" });
    // Um único pagamento ativo por encomenda; um novo só pode ser iniciado depois de o anterior falhar/expirar/ser rejeitado.
    if (order.payments.some((payment) => activePaymentStates.includes(payment.status))) return reply.code(409).send({ error: "PAYMENT_ALREADY_ACTIVE" });
    const paymentNumber = "paymentNumber" in body.data ? body.data.paymentNumber : undefined;
    const reference = randomReference("TW-PAY");
    // O registo é criado ANTES de chamar o gateway: se a chamada falhar, fica um Payment em FAILED
    // (com o motivo), nunca um pagamento "fantasma" no gateway sem correspondência na nossa BD.
    let payment;
    try {
      payment = await prisma.payment.create({ data: { orderId: order.id, provider: body.data.provider, status: PaymentStatus.INITIATED, amountMzn: order.totalMzn, method: body.data.method, paymentNumber, reference } });
    } catch (error) {
      // Índice único parcial (migração 005): só um pagamento ativo por encomenda, mesmo com pedidos simultâneos.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "PAYMENT_ALREADY_ACTIVE" });
      throw error;
    }
    try {
      const provider = getPaymentProvider(body.data.provider);
      const providerResult = await provider.createPayment({
        amountMzn: Number(order.totalMzn),
        method: body.data.method,
        customerPhone: paymentNumber ?? order.user.phone ?? undefined,
        reference,
        webhookUrl: env.APP_PUBLIC_URL ? new URL(`/api/v1/payments/${payment.id}/webhook`, env.APP_PUBLIC_URL).toString() : undefined,
        returnUrl: env.APP_PUBLIC_URL ? new URL(`/pagamento/${payment.id}`, env.APP_PUBLIC_URL).toString() : undefined
      });
      const status = providerResult.status === "PENDING_CONFIRMATION" ? PaymentStatus.PENDING_CONFIRMATION : PaymentStatus.INITIATED;
      const updated = await prisma.payment.update({ where: { id: payment.id }, data: { status, providerPaymentId: providerResult.providerPaymentId } });
      try {
        await notifyUser({ userId: order.userId, type: "PAYMENT", title: "Pagamento iniciado", message: `Referência ${updated.reference}.`, data: { paymentId: updated.id, reference: updated.reference, status: updated.status, checkoutUrl: providerResult.checkoutUrl } });
        await notifyAdmins({ type: "PAYMENT", title: "Novo pagamento iniciado", message: `Pagamento ${updated.reference} iniciado.`, data: { paymentId: updated.id, orderId: order.id } });
      } catch (error) {
        request.log.error(error, "payment initiation side effects failed");
      }
      return reply.code(201).send({ paymentId: updated.id, reference: updated.reference, status: updated.status, amountMzn: updated.amountMzn, paymentNumber: updated.paymentNumber, checkoutUrl: providerResult.checkoutUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "PAYMENT_INITIATION_FAILED";
      await prisma.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED, failureMessage: message } });
      return reply.code(message === "ZUMBOPAY_NOT_CONFIGURED" ? 503 : 502).send({ error: message, paymentId: payment.id });
    }
  });

  app.get("/payments/:id", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const payment = await prisma.payment.findUnique({ where: { id: parsed.data.id }, include: { order: true } });
    if (!payment) return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    if (!isAdmin(request.auth!.roles) && payment.order.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    return { ...payment, failureCode: isAdmin(request.auth!.roles) ? payment.failureCode : undefined, failureMessage: isAdmin(request.auth!.roles) ? payment.failureMessage : undefined };
  });

  app.post("/payments/:id/webhook", async (request, reply) => {
    // Segredo obrigatório em TODOS os ambientes (antes só era exigido em production).
    const configuredSecret = env.ZUMBOPAY_WEBHOOK_SECRET;
    if (!configuredSecret) return reply.code(503).send({ error: "WEBHOOK_NOT_CONFIGURED" });
    const suppliedSecret = request.headers["x-twisisa-webhook-secret"];
    if (typeof suppliedSecret !== "string" || !safeEqual(suppliedSecret, configuredSecret)) return reply.code(401).send({ error: "INVALID_WEBHOOK_SIGNATURE" });
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = webhookSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const current = await prisma.payment.findUnique({ where: { id: params.data.id }, include: { order: true } });
    if (!current) return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    if (current.provider !== "ZUMBOPAY") return reply.code(409).send({ error: "PAYMENT_PROVIDER_MISMATCH" });
    if (current.providerPaymentId && body.data.providerPaymentId && current.providerPaymentId !== body.data.providerPaymentId) return reply.code(409).send({ error: "PROVIDER_PAYMENT_ID_MISMATCH" });
    // Pagamento já concluído: reenvios e estados posteriores são ignorados (idempotência).
    if (finalPaymentStates.includes(current.status)) return { ok: true, ignored: true };

    const targetStatus = PaymentStatus[body.data.status];
    const outcome = await prisma.$transaction(async (tx) => {
      // Atualização condicional: dois webhooks concorrentes não processam duas vezes.
      const changed = await tx.payment.updateMany({
        where: { id: current.id, status: { notIn: finalPaymentStates } },
        data: {
          status: targetStatus,
          transactionCode: body.data.transactionCode,
          providerPaymentId: current.providerPaymentId ?? body.data.providerPaymentId,
          failureCode: body.data.failureCode,
          failureMessage: body.data.failureMessage,
          confirmedAt: targetStatus === PaymentStatus.SUCCESS ? new Date() : undefined
        }
      });
      if (changed.count === 0) return { applied: false, orderPaid: false };
      let orderPaid = false;
      if (targetStatus === PaymentStatus.SUCCESS) {
        // Só passa a PAID se a encomenda ainda aguarda pagamento (não ressuscita CANCELLED).
        const moved = await tx.order.updateMany({ where: { id: current.orderId, status: { in: payableOrderStates } }, data: { status: OrderStatus.PAID } });
        if (moved.count === 1) {
          await tx.orderStatusHistory.create({ data: { orderId: current.orderId, from: current.order.status, to: OrderStatus.PAID, reason: "Gateway payment confirmed" } });
          orderPaid = true;
        }
      }
      return { applied: true, orderPaid };
    }).catch(async (error: unknown) => {
      // Notificação tardia de um pagamento antigo enquanto já existe outro ativo na mesma encomenda: responde 200 (para o
      // gateway não reenviar para sempre) e deixa o aviso ao admin, que decide o reembolso/reconciliação.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        await notifyAdmins({ type: "PAYMENT", title: "Pagamento em conflito", message: `O gateway notificou ${current.reference} (${body.data.status}) mas a encomenda ${current.order.orderNumber} já tem outro pagamento ativo. Verificar manualmente.`, data: { paymentId: current.id, orderId: current.orderId } }).catch((notifyError) => request.log.error(notifyError, "conflict alert failed"));
        return null;
      }
      throw error;
    });
    if (!outcome) return { ok: true, ignored: true, conflict: true };
    if (!outcome.applied) return { ok: true, ignored: true };

    // Efeitos secundários: uma falha aqui não pode devolver 500 ao gateway (provocaria reenvios).
    try {
      if (targetStatus === PaymentStatus.SUCCESS) {
        if (outcome.orderPaid) {
          await ensureInvoice(current.orderId);
          await notifyUser({ userId: current.order.userId, type: "PAYMENT", title: "Pagamento confirmado", message: "O seu pagamento foi confirmado com sucesso.", data: { paymentId: current.id, orderId: current.orderId } });
          await notifyAdmins({ type: "PAYMENT", title: "Venda paga", message: `A encomenda ${current.order.orderNumber} foi paga.`, data: { paymentId: current.id, orderId: current.orderId } });
          await notifyReferralCompletedIfFirst(current.order.userId, current.orderId).catch((error) => request.log.error(error, "referral completion notification failed"));
        } else {
          await notifyAdmins({ type: "PAYMENT", title: "Pagamento recebido para encomenda não pagável", message: `Pagamento ${current.reference} confirmado, mas a encomenda ${current.order.orderNumber} está em ${current.order.status}. Verificar reembolso.`, data: { paymentId: current.id, orderId: current.orderId } });
        }
      } else if (targetStatus === PaymentStatus.FAILED) {
        await notifyUser({ userId: current.order.userId, type: "PAYMENT", title: "Pagamento não concluído", message: body.data.failureMessage ?? "O pagamento não foi concluído.", data: { paymentId: current.id, status: targetStatus } });
      } else if (targetStatus === PaymentStatus.TIMEOUT) {
        await notifyUser({ userId: current.order.userId, type: "PAYMENT", title: "Pagamento expirado", message: "O tempo para concluir o pagamento expirou.", data: { paymentId: current.id, status: targetStatus } });
      } else {
        await notifyUser({ userId: current.order.userId, type: "PAYMENT", title: "Pagamento em confirmação", message: "A confirmação do pagamento está pendente.", data: { paymentId: current.id, status: targetStatus } });
      }
      await audit({ action: "PAYMENT_WEBHOOK", entity: "Payment", entityId: current.id, metadata: body.data });
    } catch (error) {
      request.log.error(error, "webhook side effects failed");
    }
    return { ok: true, paymentId: current.id, status: targetStatus };
  });

  app.post("/payments/:id/proof", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const payment = await prisma.payment.findUnique({ where: { id: params.data.id }, include: { order: true } });
    if (!payment) return reply.code(404).send({ error: "PAYMENT_NOT_FOUND" });
    if (payment.order.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    // Só para pagamentos manuais, e nunca depois de já confirmado.
    if (payment.provider !== "MANUAL") return reply.code(409).send({ error: "PROOF_NOT_APPLICABLE" });
    if (finalPaymentStates.includes(payment.status)) return reply.code(409).send({ error: "PAYMENT_ALREADY_FINAL" });
    if (!proofAllowedStates.includes(payment.status)) return reply.code(409).send({ error: "PAYMENT_NOT_ACCEPTING_PROOF" });
    if (!payableOrderStates.includes(payment.order.status)) return reply.code(409).send({ error: "ORDER_PAYMENT_NOT_ALLOWED" });
    const parsed = z.object({ proofUrl: z.string().url().max(2000) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const proofUrl = new URL(parsed.data.proofUrl);
    // Só https, e só o domínio do Cloudinary quando este está configurado — impede javascript:/data: guardados e abertos no painel do admin.
    if (proofUrl.protocol !== "https:") return reply.code(400).send({ error: "PROOF_URL_MUST_BE_HTTPS" });
    // Hostname exato e pasta da NOSSA conta (/<cloud_name>/): endsWith() aceitava qualquer subdomínio e qualquer conta Cloudinary.
    if (env.CLOUDINARY_CLOUD_NAME && (proofUrl.hostname !== "res.cloudinary.com" || !proofUrl.pathname.startsWith(`/${env.CLOUDINARY_CLOUD_NAME}/`))) return reply.code(400).send({ error: "PROOF_URL_MUST_BE_UPLOADED" });
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.payment.update({ where: { id: payment.id }, data: { proofUrl: parsed.data.proofUrl, status: PaymentStatus.PROOF_SUBMITTED } });
      await tx.order.updateMany({ where: { id: payment.orderId, status: OrderStatus.PENDING_PAYMENT }, data: { status: OrderStatus.PAYMENT_REVIEW } });
      return result;
    });
    try {
      await notifyAdmins({ type: "PAYMENT", title: "Comprovativo submetido", message: `Comprovativo da referência ${payment.reference}.`, data: { paymentId: payment.id, orderId: payment.orderId } });
    } catch (error) {
      request.log.error(error, "proof side effects failed");
    }
    return updated;
  });

  app.post("/admin/payments/:id/review", { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ approved: z.boolean(), note: z.string().max(500).optional() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findUnique({ where: { id: params.data.id }, include: { order: true } });
        if (!payment) throw new Error("PAYMENT_NOT_FOUND");
        // Só se revê um comprovativo ainda por decidir, e nunca sobre uma encomenda já cancelada.
        if (payment.status !== PaymentStatus.PROOF_SUBMITTED && payment.status !== PaymentStatus.UNDER_REVIEW) throw new Error("PAYMENT_NOT_REVIEWABLE");
        if (payment.order.status !== OrderStatus.PAYMENT_REVIEW && payment.order.status !== OrderStatus.PENDING_PAYMENT) throw new Error("ORDER_NOT_REVIEWABLE");
        const status = body.data.approved ? PaymentStatus.PAYMENT_CONFIRMED : PaymentStatus.PAYMENT_REJECTED;
        const updatedPayment = await tx.payment.update({ where: { id: payment.id }, data: { status, confirmedAt: body.data.approved ? new Date() : undefined, failureMessage: body.data.approved ? undefined : (body.data.note ?? "Rejected by admin") } });
        if (body.data.approved) {
          await tx.order.update({ where: { id: payment.orderId }, data: { status: OrderStatus.PAID, statusHistory: { create: { from: payment.order.status, to: OrderStatus.PAID, reason: body.data.note ?? "Payment proof approved", actorId: request.auth!.userId } } } });
        } else if (payment.order.status === OrderStatus.PAYMENT_REVIEW) {
          // Comprovativo rejeitado: volta a aguardar pagamento, para o cliente poder reenviar ou escolher outro método.
          await tx.order.update({ where: { id: payment.orderId }, data: { status: OrderStatus.PENDING_PAYMENT, statusHistory: { create: { from: OrderStatus.PAYMENT_REVIEW, to: OrderStatus.PENDING_PAYMENT, reason: body.data.note ?? "Payment proof rejected", actorId: request.auth!.userId } } } });
        }
        return { updatedPayment, order: payment.order };
      });
      try {
        if (body.data.approved) await ensureInvoice(result.updatedPayment.orderId);
        await notifyUser({ userId: result.order.userId, type: "PAYMENT", title: body.data.approved ? "Pagamento confirmado" : "Comprovativo rejeitado", message: body.data.approved ? "O seu comprovativo foi aprovado e o pagamento confirmado." : (body.data.note ?? "O seu comprovativo foi rejeitado. Por favor, submeta um novo."), data: { paymentId: result.updatedPayment.id } });
        if (body.data.approved) await notifyReferralCompletedIfFirst(result.order.userId, result.updatedPayment.orderId).catch((error) => request.log.error(error, "referral completion notification failed"));
        await audit({ actorId: request.auth!.userId, action: body.data.approved ? "PAYMENT_APPROVED" : "PAYMENT_REJECTED", entity: "Payment", entityId: result.updatedPayment.id, metadata: { note: body.data.note } });
      } catch (error) {
        request.log.error(error, "payment review side effects failed");
      }
      return result.updatedPayment;
    } catch (error) {
      const message = error instanceof Error ? error.message : "REVIEW_FAILED";
      const map: Record<string, number> = { PAYMENT_NOT_FOUND: 404, PAYMENT_NOT_REVIEWABLE: 409, ORDER_NOT_REVIEWABLE: 409 };
      return reply.code(map[message] ?? 500).send({ error: map[message] ? message : "REVIEW_FAILED" });
    }
  });
}
