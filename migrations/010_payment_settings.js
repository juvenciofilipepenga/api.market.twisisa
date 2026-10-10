export const name = "010_payment_settings.js";

// Definições de pagamento (uma linha, id = 'main'):
//  - interruptores: pagamento online (ZumboPay) e pagamento manual, editáveis no admin SEM redeploy;
//  - dados da loja para receber pagamento manual (M-Pesa, e-Mola, NIB) e instruções;
//  - contadores do "disjuntor": falhas seguidas do ZumboPay → desvia automaticamente para o pagamento manual.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "PaymentSettings" (
      "id" TEXT PRIMARY KEY DEFAULT 'main',
      "onlineEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
      "manualEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
      "mpesaNumber" TEXT,
      "mpesaName" TEXT,
      "emolaNumber" TEXT,
      "emolaName" TEXT,
      "bankName" TEXT,
      "bankNib" TEXT,
      "bankHolder" TEXT,
      "instructions" TEXT,
      "zpFailures" INTEGER NOT NULL DEFAULT 0,
      "zpFailureAt" TIMESTAMP(3),
      "zpDegradedUntil" TIMESTAMP(3),
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaymentSettings_singleton" CHECK ("id" = 'main')
    );
  `);
  await client.query(`INSERT INTO "PaymentSettings" ("id") VALUES ('main') ON CONFLICT ("id") DO NOTHING;`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS "PaymentSettings";`);
}
