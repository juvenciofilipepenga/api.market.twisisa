export const name = "014_password_reset.js";

// Recuperação de conta por email (EmailJS):
//  - PasswordReset: um registo por link enviado. Guarda só o HASH (SHA-256) do token: quem ler a base de dados
//    não consegue usar links pendentes. Validade curta, uso único (usedAt também marca links substituídos por um mais recente).
//  - User.passwordChangedAt: tokens de acesso emitidos ANTES da última mudança de palavra-passe deixam de valer,
//    para que redefinir a palavra-passe também expulse quem tinha entrado com a antiga.
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS "PasswordReset" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
      "tokenHash" TEXT NOT NULL,
      "expiresAt" TIMESTAMPTZ NOT NULL,
      "usedAt" TIMESTAMPTZ,
      "requestIp" TEXT,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "PasswordReset_tokenHash_key" ON "PasswordReset"("tokenHash");
    CREATE INDEX IF NOT EXISTS "PasswordReset_userId_createdAt_idx" ON "PasswordReset"("userId", "createdAt" DESC);
    CREATE INDEX IF NOT EXISTS "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMPTZ;
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE "User" DROP COLUMN IF EXISTS "passwordChangedAt";`);
  await client.query(`DROP TABLE IF EXISTS "PasswordReset";`);
}
