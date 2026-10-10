export const name = "011_manual_payment_claim.js";

// Pagamento manual (M-Pesa / e-Mola para a conta da loja):
//  - payerName: nome da conta com que o cliente vai pagar (o admin confere-o no histórico);
//  - paidClaimedAt: quando o cliente carregou em "Já paguei" (só estes pedidos chegam ao admin).
export async function up(client) {
  await client.query(`ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "payerName" TEXT;`);
  await client.query(`ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "paidClaimedAt" TIMESTAMP(3);`);
}

export async function down(client) {
  await client.query(`ALTER TABLE "Payment" DROP COLUMN IF EXISTS "paidClaimedAt";`);
  await client.query(`ALTER TABLE "Payment" DROP COLUMN IF EXISTS "payerName";`);
}
