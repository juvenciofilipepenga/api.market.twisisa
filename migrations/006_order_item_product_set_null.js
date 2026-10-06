export const name = "006_order_item_product_set_null.js";

// Apagar um produto já encomendado deixa de ser bloqueado pela base de dados. A linha da encomenda guarda uma
// cópia (nome, preço, variante, quantidade), por isso o histórico, as facturas e os totais continuam iguais;
// só a ligação ao produto apagado passa a NULL (como já acontecia com a variante).
export async function up(client) {
  await client.query(`
    ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_productId_fkey";
    ALTER TABLE "OrderItem" ALTER COLUMN "productId" DROP NOT NULL;
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  `);
}

// Reverter só é possível se nenhuma linha ficou com productId NULL (produto apagado depois de encomendado).
export async function down(client) {
  const { rows } = await client.query(`SELECT COUNT(*)::int AS n FROM "OrderItem" WHERE "productId" IS NULL`);
  if (rows[0].n > 0) throw new Error(`Não é possível reverter: ${rows[0].n} linha(s) de encomenda já não têm produto.`);
  await client.query(`
    ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_productId_fkey";
    ALTER TABLE "OrderItem" ALTER COLUMN "productId" SET NOT NULL;
    ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON UPDATE CASCADE;
  `);
}
