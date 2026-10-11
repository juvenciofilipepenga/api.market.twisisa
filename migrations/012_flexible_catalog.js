export const name = "012_flexible_catalog.js";

// Catálogo flexível (fase 1). NADA é apagado e tudo é idempotente (IF NOT EXISTS / só preenche o que está vazio):
//  1) CategoryAttribute / ProductAttributeValue: características técnicas definidas por categoria (RAM, processador, material…).
//  2) ProductVariant ganha: options (JSONB, ex.: {"Cor":"#000000","Tamanho":"M"}), optionKey (chave canónica, única por produto
//     entre variantes ativas), sku (único entre variantes ativas) e priceMzn (opcional: vazio = herda o preço do produto).
//     As colunas antigas colorHex/size ficam, e as variantes existentes são convertidas para options sem perder nada.
//  3) OrderItem guarda também o texto da variante e o SKU no momento da compra.
//  4) ProductImage pode apontar para uma variante (imagem específica de uma variante).
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "CategoryAttribute" (
      "id" TEXT NOT NULL,
      "categoryId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "key" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "required" BOOLEAN NOT NULL DEFAULT FALSE,
      "showPublic" BOOLEAN NOT NULL DEFAULT TRUE,
      "filterable" BOOLEAN NOT NULL DEFAULT FALSE,
      "unit" TEXT,
      "options" JSONB NOT NULL DEFAULT '[]'::jsonb,
      "sortOrder" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CategoryAttribute_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "CategoryAttribute_type_check" CHECK ("type" IN ('TEXT','NUMBER','BOOLEAN','SELECT','MEASURE')),
      CONSTRAINT "CategoryAttribute_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "CategoryAttribute_categoryId_key_key" ON "CategoryAttribute"("categoryId", "key");
    CREATE INDEX IF NOT EXISTS "CategoryAttribute_categoryId_sortOrder_idx" ON "CategoryAttribute"("categoryId", "sortOrder");

    CREATE TABLE IF NOT EXISTS "ProductAttributeValue" (
      "id" TEXT NOT NULL,
      "productId" TEXT NOT NULL,
      "attributeId" TEXT NOT NULL,
      "valueText" TEXT,
      "valueNumber" DECIMAL(18,4),
      "valueBool" BOOLEAN,
      CONSTRAINT "ProductAttributeValue_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "ProductAttributeValue_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "ProductAttributeValue_attributeId_fkey" FOREIGN KEY ("attributeId") REFERENCES "CategoryAttribute"("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "ProductAttributeValue_productId_attributeId_key" ON "ProductAttributeValue"("productId", "attributeId");
    CREATE INDEX IF NOT EXISTS "ProductAttributeValue_attributeId_idx" ON "ProductAttributeValue"("attributeId");
  `);

  await client.query(`
    ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "sku" TEXT;
    ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "priceMzn" DECIMAL(12,2);
    ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "options" JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE "ProductVariant" ADD COLUMN IF NOT EXISTS "optionKey" TEXT;
  `);

  // Converte cor/tamanho existentes em options + chave canónica ("cor=#000000|tamanho=m": nomes minúsculos por ordem alfabética).
  // Só toca nas linhas ainda sem chave, por isso repetir a migração não altera nada.
  await client.query(`
    UPDATE "ProductVariant" SET
      "options" = jsonb_strip_nulls(jsonb_build_object('Cor', "colorHex", 'Tamanho', "size")),
      "optionKey" = CASE
        WHEN "colorHex" IS NULL AND "size" IS NULL THEN 'id:' || "id"
        ELSE concat_ws('|',
          CASE WHEN "colorHex" IS NOT NULL THEN 'cor=' || lower("colorHex") END,
          CASE WHEN "size" IS NOT NULL THEN 'tamanho=' || lower(btrim("size")) END)
      END
    WHERE "optionKey" IS NULL;
  `);

  // A nova regra ignora maiúsculas ("M" e "m" passam a ser a mesma combinação). Se já existirem duplicados ATIVOS, não se
  // apaga nada: as repetidas ficam com um sufixo único na chave (visíveis e corrigíveis no admin) e o índice cria-se sem falhar.
  await client.query(`
    WITH ranked AS (
      SELECT "id", row_number() OVER (PARTITION BY "productId", "optionKey" ORDER BY "createdAt", "id") AS rn
      FROM "ProductVariant" WHERE "active" = TRUE
    )
    UPDATE "ProductVariant" v SET "optionKey" = v."optionKey" || '|dup:' || v."id"
    FROM ranked r WHERE v."id" = r."id" AND r.rn > 1;
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_productId_optionKey_active_key" ON "ProductVariant"("productId", "optionKey") WHERE "active" = TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS "ProductVariant_sku_active_key" ON "ProductVariant"(lower("sku")) WHERE "sku" IS NOT NULL AND "active" = TRUE;
  `);

  await client.query(`
    ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "variantLabel" TEXT;
    ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "sku" TEXT;
    ALTER TABLE "ProductImage" ADD COLUMN IF NOT EXISTS "variantId" TEXT;
  `);
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ProductImage_variantId_fkey') THEN
        ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS "ProductImage_variantId_idx" ON "ProductImage"("variantId");
  `);
}

// Reverter apaga as características definidas e os valores guardados nesta fase (as variantes e as encomendas ficam intactas).
export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS "ProductImage_variantId_idx";`);
  await client.query(`ALTER TABLE "ProductImage" DROP CONSTRAINT IF EXISTS "ProductImage_variantId_fkey";`);
  await client.query(`ALTER TABLE "ProductImage" DROP COLUMN IF EXISTS "variantId";`);
  await client.query(`ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "sku";`);
  await client.query(`ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "variantLabel";`);
  await client.query(`DROP INDEX IF EXISTS "ProductVariant_sku_active_key";`);
  await client.query(`DROP INDEX IF EXISTS "ProductVariant_productId_optionKey_active_key";`);
  await client.query(`ALTER TABLE "ProductVariant" DROP COLUMN IF EXISTS "optionKey";`);
  await client.query(`ALTER TABLE "ProductVariant" DROP COLUMN IF EXISTS "options";`);
  await client.query(`ALTER TABLE "ProductVariant" DROP COLUMN IF EXISTS "priceMzn";`);
  await client.query(`ALTER TABLE "ProductVariant" DROP COLUMN IF EXISTS "sku";`);
  await client.query(`DROP TABLE IF EXISTS "ProductAttributeValue";`);
  await client.query(`DROP TABLE IF EXISTS "CategoryAttribute";`);
}
