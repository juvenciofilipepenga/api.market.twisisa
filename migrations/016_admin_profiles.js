export const name = "016_admin_profiles.js";

// Perfis de administração: cada administrador tem uma lista de perfis (Encomendas, Finanças, Catálogo, Suporte, Conteúdo)
// e as permissões saem daí (ver src/lib/permissions.ts). Os ADMIN que já existem recebem TODOS os perfis, por isso
// não perdem nenhum acesso; passam a poder ser limitados pelo SUPER_ADMIN no ecrã "Equipa".
export async function up(client) {
  await client.query(`
    DO $$ BEGIN
      CREATE TYPE "AdminProfile" AS ENUM ('ORDERS', 'FINANCE', 'CATALOG', 'SUPPORT', 'CONTENT');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "adminProfiles" "AdminProfile"[] NOT NULL DEFAULT ARRAY[]::"AdminProfile"[];
  `);
  await client.query(`
    UPDATE "User" u
    SET "adminProfiles" = ARRAY['ORDERS', 'FINANCE', 'CATALOG', 'SUPPORT', 'CONTENT']::"AdminProfile"[]
    WHERE cardinality(u."adminProfiles") = 0
      AND EXISTS (
        SELECT 1 FROM "UserRole" ur JOIN "Role" r ON r."id" = ur."roleId"
        WHERE ur."userId" = u."id" AND r."name" = 'ADMIN'
      );
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE "User" DROP COLUMN IF EXISTS "adminProfiles";
    DROP TYPE IF EXISTS "AdminProfile";
  `);
}
