import { prisma } from "../lib/prisma.js";

// Dados do emissor que aparecem na fatura. Editáveis pelo admin; cada fatura emitida guarda uma CÓPIA (Invoice.issuer).
export type InvoiceIssuer = {
  companyName: string;
  legalName: string | null;
  nuit: string | null;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logoUrl: string | null;
  signatureUrl: string | null;
  signerName: string | null;
  signerRole: string | null;
  accentColor: string;
  footerNote: string | null;
  terms: string | null;
  bankDetails: string | null;
  vatRatePercent: number;
  showSignature: boolean;
};

export async function getInvoiceSettings() {
  return prisma.invoiceSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
}

export function toIssuer(settings: Awaited<ReturnType<typeof getInvoiceSettings>>): InvoiceIssuer {
  return {
    companyName: settings.companyName,
    legalName: settings.legalName,
    nuit: settings.nuit,
    address: settings.address,
    city: settings.city,
    phone: settings.phone,
    email: settings.email,
    website: settings.website,
    logoUrl: settings.logoUrl,
    signatureUrl: settings.signatureUrl,
    signerName: settings.signerName,
    signerRole: settings.signerRole,
    accentColor: settings.accentColor,
    footerNote: settings.footerNote,
    terms: settings.terms,
    bankDetails: settings.bankDetails,
    vatRatePercent: Number(settings.vatRatePercent),
    showSignature: settings.showSignature
  };
}
