import PDFDocument from "pdfkit";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { finalSuccess } from "./paymentFlow.js";
import { getInvoiceSettings, toIssuer, type InvoiceIssuer } from "./invoiceSettings.js";

// Fatura SEMPRE emitida só depois de o pagamento estar confirmado (ver paymentFlow.settlePayment / revisão do admin).
// Número sequencial (prefixo-ano-000001) vindo de um contador atómico, e cópia dos dados do emissor no momento da emissão:
// mudar o NUIT ou o logótipo mais tarde não reescreve faturas antigas.
export async function ensureInvoice(orderId: string) {
  const existing = await prisma.invoice.findUnique({ where: { orderId } });
  if (existing) return existing;
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true, payments: true } });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const payment = order.payments.find((item) => finalSuccess.includes(item.status));
  const settings = await getInvoiceSettings();
  try {
    return await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ n: number; prefix: string }>>`
        UPDATE "InvoiceSettings" SET "nextNumber" = "nextNumber" + 1 WHERE "id" = 'main'
        RETURNING "nextNumber" - 1 AS n, "numberPrefix" AS prefix`;
      const row = rows[0];
      if (!row) throw new Error("INVOICE_SETTINGS_MISSING");
      const invoiceNumber = `${row.prefix}-${new Date().getFullYear()}-${String(row.n).padStart(6, "0")}`;
      return tx.invoice.create({
        data: {
          invoiceNumber,
          orderId: order.id,
          userId: order.userId,
          customerName: order.user.name,
          customerEmail: order.user.email,
          customerPhone: order.user.phone,
          subtotalMzn: order.subtotalMzn,
          shippingMzn: order.shippingMzn,
          discountMzn: order.discountMzn,
          totalMzn: order.totalMzn,
          paymentMethod: payment?.method,
          paymentReference: payment?.transactionCode ?? payment?.reference,
          issuer: toIssuer(settings) as unknown as Prisma.InputJsonValue
        }
      });
    });
  } catch (error) {
    // Dois pedidos em simultâneo para a mesma encomenda: ganha o primeiro (a transacção do outro desfaz também o contador).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const again = await prisma.invoice.findUnique({ where: { orderId } });
      if (again) return again;
    }
    throw error;
  }
}

export type InvoicePdfData = {
  number: string;
  issuedAt: Date;
  issuer: InvoiceIssuer;
  orderNumber: string;
  customer: { name: string; email: string; phone: string | null };
  items: Array<{ name: string; quantity: number; unitMzn: number; subtotalMzn: number }>;
  subtotalMzn: number;
  shippingMzn: number;
  discountMzn: number;
  totalMzn: number;
  paymentMethod: string | null;
  paymentReference: string | null;
  paid: boolean;
};

const METHOD_LABEL: Record<string, string> = { MPESA: "M-Pesa", EMOLA: "e-Mola", CARD: "Cartão Visa / Mastercard" };

export async function invoicePdf(invoiceId: string): Promise<Buffer> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { order: { include: { items: true } } } });
  if (!invoice) throw new Error("INVOICE_NOT_FOUND");
  const issuer = (invoice.issuer as unknown as InvoiceIssuer | null) ?? toIssuer(await getInvoiceSettings());
  return renderInvoicePdf({
    number: invoice.invoiceNumber,
    issuedAt: invoice.issuedAt,
    issuer,
    orderNumber: invoice.order.orderNumber,
    customer: { name: invoice.customerName, email: invoice.customerEmail, phone: invoice.customerPhone },
    items: invoice.order.items.map((item) => ({
      name: [item.productName, item.variantSize ? `Tam. ${item.variantSize}` : null].filter(Boolean).join(" · "),
      quantity: item.quantity,
      unitMzn: Number(item.unitPriceMzn),
      subtotalMzn: Number(item.subtotalMzn)
    })),
    subtotalMzn: Number(invoice.subtotalMzn),
    shippingMzn: Number(invoice.shippingMzn),
    discountMzn: Number(invoice.discountMzn),
    totalMzn: Number(invoice.totalMzn),
    paymentMethod: invoice.paymentMethod,
    paymentReference: invoice.paymentReference,
    paid: true
  });
}

// Pré-visualização para o admin: dados fictícios, definições REAIS (as guardadas).
export async function invoicePreviewPdf(): Promise<Buffer> {
  const issuer = toIssuer(await getInvoiceSettings());
  return renderInvoicePdf({
    number: "FT-PREVIEW-000001",
    issuedAt: new Date(),
    issuer,
    orderNumber: "TW-000000",
    customer: { name: "Cliente de Exemplo", email: "cliente@exemplo.co.mz", phone: "84 000 0000" },
    items: [
      { name: "Produto de exemplo", quantity: 2, unitMzn: 1250, subtotalMzn: 2500 },
      { name: "Outro produto · Tam. M", quantity: 1, unitMzn: 890, subtotalMzn: 890 }
    ],
    subtotalMzn: 3390, shippingMzn: 150, discountMzn: 0, totalMzn: 3540,
    paymentMethod: "MPESA", paymentReference: "EXEMPLO123", paid: true
  });
}

async function fetchImage(url: string | null): Promise<Buffer | null> {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    // pdfkit só lê PNG/JPEG: o Cloudinary converte à saída.
    const target = parsed.hostname === "res.cloudinary.com"
      ? url.replace("/upload/", "/upload/f_png/").replace(/\.(webp|avif|gif|svg)(\?.*)?$/i, ".png")
      : url;
    const response = await fetch(target, { signal: AbortSignal.timeout(5000) });
    if (!response.ok || !/image\/(png|jpe?g)/.test(response.headers.get("content-type") ?? "")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > 3_000_000 ? null : buffer;
  } catch {
    return null;
  }
}

const money = (value: number) => {
  const [int = "0", dec = "00"] = Math.abs(value).toFixed(2).split(".");
  return `${value < 0 ? "-" : ""}${int.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${dec} MT`;
};
const dateStr = (d: Date) => d.toLocaleDateString("pt-PT", { day: "2-digit", month: "long", year: "numeric" });

export async function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  const { issuer } = data;
  const [logo, signature] = await Promise.all([fetchImage(issuer.logoUrl), issuer.showSignature ? fetchImage(issuer.signatureUrl) : Promise.resolve(null)]);
  const accent = /^#[0-9a-f]{6}$/i.test(issuer.accentColor) ? issuer.accentColor : "#EE0006";
  const ink = "#1A1412", muted = "#6B605B", line = "#E6DFDA";

  const doc = new PDFDocument({ size: "A4", margins: { top: 48, bottom: 4, left: 48, right: 48 }, info: { Title: `Fatura ${data.number}`, Author: issuer.companyName } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const L = 48, R = doc.page.width - 48, W = R - L;
  doc.rect(0, 0, doc.page.width, 6).fill(accent);

  // Cabeçalho: logótipo (ou nome) à esquerda, título e número à direita.
  let y = 36;
  if (logo) {
    try { doc.image(logo, L, y, { fit: [130, 54] }); } catch { doc.font("Helvetica-Bold").fontSize(18).fillColor(ink).text(issuer.companyName, L, y + 8); }
  } else {
    doc.font("Helvetica-Bold").fontSize(18).fillColor(ink).text(issuer.companyName, L, y + 8, { width: 260 });
  }
  doc.font("Helvetica-Bold").fontSize(22).fillColor(accent).text("FATURA", L, y, { width: W, align: "right" });
  doc.font("Helvetica").fontSize(10).fillColor(muted).text(`Nº ${data.number}`, L, y + 28, { width: W, align: "right" });
  doc.text(dateStr(data.issuedAt), L, y + 42, { width: W, align: "right" });

  // Dados do emissor
  y = 104;
  const issuerLines = [
    issuer.legalName && issuer.legalName !== issuer.companyName ? issuer.legalName : null,
    issuer.nuit ? `NUIT ${issuer.nuit}` : null,
    [issuer.address, issuer.city].filter(Boolean).join(", ") || null,
    [issuer.phone, issuer.email].filter(Boolean).join("  ·  ") || null,
    issuer.website
  ].filter((v): v is string => Boolean(v));
  doc.font("Helvetica").fontSize(9).fillColor(muted);
  for (const text of issuerLines) { doc.text(text, L, y, { width: 280 }); y = doc.y + 1; }
  y = Math.max(y + 12, 150);
  doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(line).stroke();

  // Cliente | Detalhes
  y += 14;
  const colW = W / 2 - 10;
  doc.font("Helvetica-Bold").fontSize(8).fillColor(muted).text("FACTURADO A", L, y).text("DETALHES", L + colW + 20, y);
  doc.font("Helvetica-Bold").fontSize(11).fillColor(ink).text(data.customer.name, L, y + 14, { width: colW });
  doc.font("Helvetica").fontSize(9.5).fillColor(muted).text(data.customer.email, L, doc.y + 1, { width: colW });
  if (data.customer.phone) doc.text(data.customer.phone, L, doc.y + 1, { width: colW });
  const leftEnd = doc.y;
  doc.font("Helvetica").fontSize(9.5).fillColor(muted);
  let dy = y + 14;
  const detail = (label: string, value: string) => {
    doc.fillColor(muted).text(label, L + colW + 20, dy, { width: 80 });
    doc.fillColor(ink).text(value, L + colW + 100, dy, { width: colW - 80 });
    dy = Math.max(doc.y, dy + 14) + 1;
  };
  detail("Encomenda", data.orderNumber);
  if (data.paymentMethod) detail("Pagamento", METHOD_LABEL[data.paymentMethod] ?? data.paymentMethod);
  if (data.paymentReference) detail("Referência", data.paymentReference);
  y = Math.max(leftEnd, dy) + 18;

  // Tabela de artigos
  const cQty = L + W * 0.58, cUnit = L + W * 0.68, cTot = L + W * 0.84;
  const header = (top: number) => {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(muted);
    doc.text("DESCRIÇÃO", L, top, { width: cQty - L - 8 });
    doc.text("QTD", cQty, top, { width: cUnit - cQty - 8, align: "right" });
    doc.text("PREÇO", cUnit, top, { width: cTot - cUnit - 8, align: "right" });
    doc.text("TOTAL", cTot, top, { width: R - cTot, align: "right" });
    doc.moveTo(L, top + 14).lineTo(R, top + 14).lineWidth(1).strokeColor(ink).stroke();
    return top + 22;
  };
  y = header(y);
  for (const item of data.items) {
    doc.font("Helvetica").fontSize(10);
    const h = Math.max(doc.heightOfString(item.name, { width: cQty - L - 8 }), 12);
    if (y + h + 12 > doc.page.height - 190) { doc.addPage(); doc.rect(0, 0, doc.page.width, 6).fill(accent); y = header(36); }
    doc.fillColor(ink).text(item.name, L, y, { width: cQty - L - 8 });
    doc.fillColor(muted).text(String(item.quantity), cQty, y, { width: cUnit - cQty - 8, align: "right" });
    doc.text(money(item.unitMzn), cUnit, y, { width: cTot - cUnit - 8, align: "right" });
    doc.fillColor(ink).text(money(item.subtotalMzn), cTot, y, { width: R - cTot, align: "right" });
    y += h + 8;
    doc.moveTo(L, y - 3).lineTo(R, y - 3).lineWidth(0.4).strokeColor(line).stroke();
  }

  // Totais
  if (y > doc.page.height - 230) { doc.addPage(); doc.rect(0, 0, doc.page.width, 6).fill(accent); y = 44; }
  y += 8;
  const row = (label: string, value: string, strong = false) => {
    doc.font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 13 : 10).fillColor(strong ? ink : muted);
    doc.text(label, cUnit - 40, y, { width: cTot - cUnit + 32, align: "left" });
    doc.text(value, cTot - 20, y, { width: R - cTot + 20, align: "right" });
    y += strong ? 22 : 15;
  };
  row("Subtotal", money(data.subtotalMzn));
  row("Envio", money(data.shippingMzn));
  if (data.discountMzn > 0) row("Desconto", `-${money(data.discountMzn)}`);
  if (issuer.vatRatePercent > 0) {
    const vat = data.totalMzn - data.totalMzn / (1 + issuer.vatRatePercent / 100);
    row(`Dos quais IVA (${issuer.vatRatePercent}%)`, money(vat));
  }
  doc.moveTo(cUnit - 40, y).lineTo(R, y).lineWidth(1).strokeColor(accent).stroke();
  y += 8;
  row("TOTAL", money(data.totalMzn), true);

  if (data.paid) {
    doc.roundedRect(L, y - 44, 74, 26, 5).lineWidth(1.4).strokeColor("#1E9E5A").stroke();
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#1E9E5A").text("PAGO", L, y - 37, { width: 74, align: "center" });
  }

  // Dados bancários / termos
  y += 14;
  const notes: Array<[string, string]> = [];
  if (issuer.bankDetails) notes.push(["DADOS BANCÁRIOS", issuer.bankDetails]);
  if (issuer.terms) notes.push(["CONDIÇÕES", issuer.terms]);
  for (const [title, text] of notes) {
    doc.font("Helvetica-Bold").fontSize(8).fillColor(muted).text(title, L, y, { width: W * 0.58 });
    doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(text, L, doc.y + 2, { width: W * 0.58 });
    y = doc.y + 10;
  }

  // Assinatura
  if (issuer.showSignature && (signature || issuer.signerName)) {
    const sy = Math.max(y + 20, doc.page.height - 190);
    const sx = R - 190;
    if (signature) { try { doc.image(signature, sx + 10, sy - 50, { fit: [170, 48] }); } catch { /* assinatura ilegível: segue sem imagem */ } }
    doc.moveTo(sx, sy).lineTo(R, sy).lineWidth(0.8).strokeColor(ink).stroke();
    if (issuer.signerName) doc.font("Helvetica-Bold").fontSize(9.5).fillColor(ink).text(issuer.signerName, sx, sy + 5, { width: 190, align: "center" });
    if (issuer.signerRole) doc.font("Helvetica").fontSize(8.5).fillColor(muted).text(issuer.signerRole, sx, doc.y + 1, { width: 190, align: "center" });
  }

  // Rodapé
  const fy = doc.page.height - 62;
  doc.moveTo(L, fy).lineTo(R, fy).lineWidth(0.5).strokeColor(line).stroke();
  doc.font("Helvetica").fontSize(8).fillColor(muted).text(issuer.footerNote || `Obrigado pela sua compra em ${issuer.companyName}.`, L, fy + 8, { width: W, align: "center", lineBreak: true, height: 30 });

  doc.end();
  return done;
}
