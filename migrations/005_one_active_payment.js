export const name = "005_one_active_payment.js";

// Um único pagamento "ativo" por encomenda, garantido pela base de dados (a verificação na aplicação não
// resiste a dois pedidos em simultâneo). A lista TEM de coincidir com activePaymentStates em src/routes/payments.ts.
export async function up(client) {
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Payment_one_active_per_order_idx" ON "Payment"("orderId")
    WHERE "status" IN ('INITIATED','AUTHENTICATING','PENDING_CONFIRMATION','PAYMENT_PENDING','PROOF_SUBMITTED','UNDER_REVIEW','SUCCESS','PAYMENT_CONFIRMED');
  `);
}

export async function down(client) {
  await client.query(`DROP INDEX IF EXISTS "Payment_one_active_per_order_idx";`);
}
