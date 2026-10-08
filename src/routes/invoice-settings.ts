import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RoleName } from "../generated/prisma/client.js";
import { cloudinaryConfigured, env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { invoicePreviewPdf } from "../services/invoice.js";
import { getInvoiceSettings } from "../services/invoiceSettings.js";

// Só https e, com Cloudinary configurado, só ficheiros da NOSSA conta (mesma regra dos comprovativos).
const imageUrl = z.string().trim().url().max(2000).refine((value) => {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (cloudinaryConfigured && env.CLOUDINARY_CLOUD_NAME) return url.hostname === "res.cloudinary.com" && url.pathname.startsWith(`/${env.CLOUDINARY_CLOUD_NAME}/`);
    return true;
  } catch { return false; }
}, "Imagem inválida");

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const settingsSchema = z.object({
  companyName: z.string().trim().min(2).max(120),
  legalName: text(160),
  nuit: z.string().trim().regex(/^\d{9}$/, "O NUIT tem 9 dígitos").nullable().optional().or(z.literal("").transform(() => null)),
  address: text(200),
  city: text(80),
  phone: text(40),
  email: z.string().trim().email().max(120).nullable().optional().or(z.literal("").transform(() => null)),
  website: text(120),
  logoUrl: imageUrl.nullable().optional().or(z.literal("").transform(() => null)),
  signatureUrl: imageUrl.nullable().optional().or(z.literal("").transform(() => null)),
  signerName: text(120),
  signerRole: text(120),
  accentColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida"),
  numberPrefix: z.string().trim().regex(/^[A-Za-z0-9]{1,8}$/, "Prefixo: 1 a 8 letras/números"),
  footerNote: text(300),
  terms: text(800),
  bankDetails: text(400),
  vatRatePercent: z.number().min(0).max(100),
  showSignature: z.boolean()
});

export async function invoiceSettingsRoutes(app: FastifyInstance): Promise<void> {
  const admin = { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] };

  app.get("/admin/invoice-settings", admin, async () => getInvoiceSettings());

  app.put("/admin/invoice-settings", admin, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT", field: parsed.error.issues[0]?.path.join(".") });
    await getInvoiceSettings();
    const updated = await prisma.invoiceSettings.update({ where: { id: "main" }, data: { ...parsed.data, nuit: parsed.data.nuit ?? null, email: parsed.data.email ?? null, logoUrl: parsed.data.logoUrl ?? null, signatureUrl: parsed.data.signatureUrl ?? null } });
    await audit({ actorId: request.auth!.userId, action: "INVOICE_SETTINGS_UPDATED", entity: "InvoiceSettings", entityId: "main", metadata: { fields: Object.keys(parsed.data) } }).catch((error) => request.log.error(error, "audit failed"));
    return updated;
  });

  // PDF de exemplo com as definições GUARDADAS (guarde primeiro, depois pré-visualize).
  app.get("/admin/invoice-settings/preview", admin, async (_request, reply) => {
    const pdf = await invoicePreviewPdf();
    return reply.header("Content-Type", "application/pdf").header("Content-Disposition", 'inline; filename="preview.pdf"').send(pdf);
  });
}
