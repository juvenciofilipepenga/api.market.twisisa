export const name = "013_product_pricing.js";

// Calculadora de preço (só admin). Os custos vivem numa tabela À PARTE de Product de propósito:
// as listas públicas (GET /products) devolvem as colunas de Product, por isso custos e margens nunca podem estar lá.
//  - ProductPricing: uma linha por produto com os custos e percentagens; o preço (Product.priceMzn) é calculado a partir dela.
//  - PricingSettings: limites de lucro (a partir de que retorno é "bom" e "excelente"); uma só linha.
// Nada é apagado: os produtos existentes ficam como estão, sem linha em ProductPricing (preço antigo, sem custos).
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "ProductPricing" (
      "productId" TEXT PRIMARY KEY REFERENCES "Product"("id") ON DELETE CASCADE,
      "purchaseMzn" DECIMAL(12,2) NOT NULL,
      "taxPct" DECIMAL(6,2) NOT NULL DEFAULT 0,
      "transportMzn" DECIMAL(12,2) NOT NULL DEFAULT 0,
      "otherCostsMzn" DECIMAL(12,2) NOT NULL DEFAULT 0,
      "returnPct" DECIMAL(8,2) NOT NULL,
      "commissionPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
      "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "PricingSettings" (
      "id" TEXT PRIMARY KEY DEFAULT 'main',
      "goodFromPct" DECIMAL(6,2) NOT NULL DEFAULT 30,
      "excellentFromPct" DECIMAL(6,2) NOT NULL DEFAULT 80,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PricingSettings_singleton" CHECK ("id" = 'main')
    );
  `);
  await client.query(`INSERT INTO "PricingSettings" ("id") VALUES ('main') ON CONFLICT ("id") DO NOTHING;`);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS "PricingSettings";`);
  await client.query(`DROP TABLE IF EXISTS "ProductPricing";`);
}
