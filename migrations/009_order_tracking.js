export const name = "009_order_tracking.js";

// Acompanhamento da encomenda paga: data prevista, transportadora e código de seguimento (na encomenda),
// e a localização/ponto de passagem em cada atualização do histórico.
export async function up(client) {
  await client.query(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "estimatedDeliveryAt" TIMESTAMP(3);`);
  await client.query(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "trackingCode" TEXT;`);
  await client.query(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "carrier" TEXT;`);
  await client.query(`ALTER TABLE "OrderStatusHistory" ADD COLUMN IF NOT EXISTS "location" TEXT;`);
}

export async function down(client) {
  await client.query(`ALTER TABLE "OrderStatusHistory" DROP COLUMN IF EXISTS "location";`);
  await client.query(`ALTER TABLE "Order" DROP COLUMN IF EXISTS "carrier";`);
  await client.query(`ALTER TABLE "Order" DROP COLUMN IF EXISTS "trackingCode";`);
  await client.query(`ALTER TABLE "Order" DROP COLUMN IF EXISTS "estimatedDeliveryAt";`);
}
