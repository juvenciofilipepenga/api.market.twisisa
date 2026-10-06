export const name = "007_order_user_created_index.js";

// "Meus pedidos" lista as encomendas de UM cliente, da mais recente para a mais antiga: este índice composto serve
// exactamente essa consulta (filtra por userId e já devolve ordenado por createdAt), sem ordenar em memória.
export async function up(client) {
  await client.query(`CREATE INDEX IF NOT EXISTS "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt" DESC);`);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS "Order_userId_createdAt_idx";`);
}
