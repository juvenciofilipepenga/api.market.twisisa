import PDFDocument from "pdfkit";
import { PaymentStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { randomReference } from "../lib/auth.js";

export async function ensureInvoice(orderId: string) {
  const existing = await prisma.invoice.findUnique({ where: { orderId } });
  if (existing) return existing;
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true, payments: true } });
  if (!order) throw new Error("ORDER_NOT_FOUND");
  const payment = order.payments.find((item) => item.status === PaymentStatus.SUCCESS || item.status === PaymentStatus.PAYMENT_CONFIRMED);
  return prisma.invoice.create({
    data: {
      invoiceNumber: randomReference("INV"),
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
      paymentReference: payment?.reference
    }
  });
}

export async function invoicePdf(invoiceId: string): Promise<Buffer> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { order: { include: { items: true } } } });
  if (!invoice) throw new Error("INVOICE_NOT_FOUND");
  const document = new PDFDocument({ margin: 50 });
  const chunks: Buffer[] = [];
  document.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => document.on("end", () => resolve(Buffer.concat(chunks))));

  document.fontSize(20).text("TWISISA MARKET");
  document.fontSize(12).text("Fatura / Invoice").moveDown();
  document.text(`Número: ${invoice.invoiceNumber}`);
  document.text(`Encomenda: ${invoice.order.orderNumber}`);
  document.text(`Data: ${invoice.issuedAt.toISOString()}`).moveDown();
  document.text(`Cliente: ${invoice.customerName}`);
  document.text(`Email: ${invoice.customerEmail}`);
  if (invoice.customerPhone) document.text(`Telefone: ${invoice.customerPhone}`);
  document.moveDown();
  for (const item of invoice.order.items) {
    document.text(`${item.productName} x${item.quantity} | ${item.unitPriceMzn.toFixed(2)} MZN | ${item.subtotalMzn.toFixed(2)} MZN`);
  }
  document.moveDown();
  document.text(`Subtotal: ${invoice.subtotalMzn.toFixed(2)} MZN`);
  document.text(`Envio: ${invoice.shippingMzn.toFixed(2)} MZN`);
  document.text(`Desconto: ${invoice.discountMzn.toFixed(2)} MZN`);
  document.fontSize(14).text(`Total: ${invoice.totalMzn.toFixed(2)} MZN`);
  if (invoice.paymentMethod) document.fontSize(10).text(`Pagamento: ${invoice.paymentMethod} | Ref.: ${invoice.paymentReference ?? "-"}`);
  document.end();
  return done;
}
