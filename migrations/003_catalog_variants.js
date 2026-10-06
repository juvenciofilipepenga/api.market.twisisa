export const name = "003_catalog_variants.js";

export async function up(client) {
  await client.query(`
    CREATE TABLE "ProductVariant" (
      "id" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "colorHex" TEXT,
      "size" TEXT,
      "stock" INTEGER NOT NULL DEFAULT 0,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
    );
    CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");
    ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    ALTER TABLE "OrderItem" ADD COLUMN "variantId" TEXT;
    ALTER TABLE "OrderItem" ADD COLUMN "variantColorHex" TEXT;
    ALTER TABLE "OrderItem" ADD COLUMN "variantSize" TEXT;
    CREATE INDEX "OrderItem_variantId_idx" ON "OrderItem"("variantId");
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_variantId_fkey"; DROP INDEX IF EXISTS "OrderItem_variantId_idx"; ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "variantSize", DROP COLUMN IF EXISTS "variantColorHex", DROP COLUMN IF EXISTS "variantId"; DROP TABLE "ProductVariant";`);
}

