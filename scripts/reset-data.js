import "dotenv/config";
import pg from "pg";

// Limpa os DADOS da base (produtos, encomendas, chats, …) para recomeçar com dados novos. NÃO apaga as tabelas
// nem o histórico de migrações, e nunca toca na tabela Role.
//
//   npm run reset:data                                   → só mostra o que seria apagado (não apaga nada)
//   npm run reset:data -- --confirm=<nome-da-base>        → apaga tudo, incluindo utilizadores
//   npm run reset:data -- --confirm=<nome-da-base> --keep-users
//                                                         → apaga tudo MENOS utilizadores, moradas e sessões
//
// Depois de apagar tudo (sem --keep-users), `npm run seed` recria os papéis e o administrador de desenvolvimento.
// Ficheiros de imagens já carregados (disco/Cloudinary) NÃO são apagados por este script.
const { Client } = pg;
const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (process.env.NODE_ENV === "production") {
  console.error("Recusado: NODE_ENV=production. Este script nunca corre em produção.");
  process.exit(1);
}

const args = process.argv.slice(2);
const keepUsers = args.includes("--keep-users");
const confirm = args.find((a) => a.startsWith("--confirm="))?.slice("--confirm=".length);
const target = new URL(databaseUrl);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));

// Sempre preservadas: o histórico de migrações e os papéis. Com --keep-users: também quem pode entrar na loja.
const PROTECTED = new Set(["_schema_migrations", "Role", ...(keepUsers ? ["User", "UserRole", "Session", "Address"] : [])]);

const client = new Client({ connectionString: databaseUrl, ssl: databaseUrl.includes("neon.tech") ? { rejectUnauthorized: false } : undefined });
try {
  await client.connect();
  const { rows } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const tables = rows.map((r) => r.table_name).filter((name) => !PROTECTED.has(name));

  console.log(`Base de dados: ${dbName}  (servidor: ${target.host})`);
  console.log(keepUsers ? "Modo: apagar tudo MENOS utilizadores, moradas e sessões.\n" : "Modo: apagar TUDO, incluindo utilizadores.\n");
  for (const table of tables) {
    const count = (await client.query(`SELECT COUNT(*)::int AS n FROM "${table}"`)).rows[0].n;
    console.log(`  ${table.padEnd(22)} ${String(count).padStart(7)} linhas`);
  }

  if (confirm !== dbName) {
    console.log(`\nNada foi apagado. Para apagar de verdade, repita com:  --confirm=${dbName}`);
    process.exit(confirm === undefined ? 0 : 1);
  }

  await client.query("BEGIN");
  try {
    await client.query(`TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  console.log(`\nFeito: ${tables.length} tabelas limpas.${keepUsers ? "" : " Corra `npm run seed` para recriar o administrador de desenvolvimento."}`);
} finally {
  await client.end();
}
