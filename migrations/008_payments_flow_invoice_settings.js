export const name = "008_payments_flow_invoice_settings.js";

// 1) Pagamento: prazo para o cliente confirmar no telemóvel (o ecrã de espera usa-o para mostrar o tempo restante).
// 2) Definições da fatura (uma única linha, id = 'main'): dados da loja, NUIT, logótipo, assinatura, rodapé, numeração.
// 3) Fatura: guarda uma CÓPIA dos dados do emissor no momento da emissão — alterar as definições depois
//    nunca reescreve faturas já emitidas.
export async function up(client) {
  await client.query(`ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);`);
  await client.query(`ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "issuer" JSONB;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "InvoiceSettings" (
      "id" TEXT PRIMARY KEY DEFAULT 'main',
      "companyName" TEXT NOT NULL DEFAULT 'Twisisa Market',
      "legalName" TEXT,
      "nuit" TEXT,
      "address" TEXT,
      "city" TEXT,
      "phone" TEXT,
      "email" TEXT,
      "website" TEXT,
      "logoUrl" TEXT,
      "signatureUrl" TEXT,
      "signerName" TEXT,
      "signerRole" TEXT,
      "accentColor" TEXT NOT NULL DEFAULT '#EE0006',
      "numberPrefix" TEXT NOT NULL DEFAULT 'FT',
      "nextNumber" INTEGER NOT NULL DEFAULT 1,
      "footerNote" TEXT,
      "terms" TEXT,
      "bankDetails" TEXT,
      "vatRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
      "showSignature" BOOLEAN NOT NULL DEFAULT TRUE,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "InvoiceSettings_singleton" CHECK ("id" = 'main')
    );
  `);
  await client.query(`INSERT INTO "InvoiceSettings" ("id") VALUES ('main') ON CONFLICT ("id") DO NOTHING;`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS "InvoiceSettings";`);
  await client.query(`ALTER TABLE "Invoice" DROP COLUMN IF EXISTS "issuer";`);
  await client.query(`ALTER TABLE "Payment" DROP COLUMN IF EXISTS "expiresAt";`);
}
