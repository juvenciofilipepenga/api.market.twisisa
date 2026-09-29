import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { invoicePdf } from "../services/invoice.js";
import { isAdmin, requireAuth } from "../middleware/auth.js";

export async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/invoices/:id", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const invoice = await prisma.invoice.findUnique({ where: { id: params.data.id } });
    if (!invoice) return reply.code(404).send({ error: "INVOICE_NOT_FOUND" });
    if (!isAdmin(request.auth!.roles) && invoice.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    return invoice;
  });

  app.get("/invoices/:id/pdf", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const invoice = await prisma.invoice.findUnique({ where: { id: params.data.id } });
    if (!invoice) return reply.code(404).send({ error: "INVOICE_NOT_FOUND" });
    if (!isAdmin(request.auth!.roles) && invoice.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    const pdf = await invoicePdf(invoice.id);
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`).send(pdf);
  });
}
