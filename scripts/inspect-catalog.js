// SÓ LEITURA. Mostra o esquema REAL das tabelas do catálogo e a qualidade dos dados, para planear a evolução sem assumir nada.
// Uso (na pasta backend):  node scripts/inspect-catalog.js
import "dotenv/config";
import pg from "pg";

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) { console.error("Falta DIRECT_URL (ou DATABASE_URL) no .env"); process.exit(1); }

const client = new pg.Client({ connectionString: url });
const T = `'Category','Product','ProductImage','ProductVariant','OrderItem'`;
const checks = [
  ["COLUNAS", `SELECT table_name AS t, column_name AS c, data_type AS tipo, is_nullable AS nulo, column_default AS defeito FROM information_schema.columns WHERE table_schema='public' AND table_name IN (${T}) ORDER BY table_name, ordinal_position`],
  ["ÍNDICES", `SELECT tablename AS t, indexname AS nome, indexdef AS def FROM pg_indexes WHERE schemaname='public' AND tablename IN (${T}) ORDER BY 1,2`],
  ["RESTRIÇÕES", `SELECT conrelid::regclass::text AS t, conname AS nome, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace='public'::regnamespace AND conrelid::regclass::text IN ('"Category"','"Product"','"ProductImage"','"ProductVariant"','"OrderItem"') ORDER BY 1,2`],
  ["CONTAGENS", `SELECT (SELECT count(*) FROM "Category") AS categorias, (SELECT count(*) FROM "Product") AS produtos, (SELECT count(*) FROM "Product" WHERE active) AS produtos_ativos, (SELECT count(*) FROM "ProductVariant") AS variantes, (SELECT count(DISTINCT "productId") FROM "ProductVariant") AS produtos_com_variantes, (SELECT count(*) FROM "OrderItem") AS linhas_de_encomenda`],
  ["VARIANTES DUPLICADAS (mesmo produto, cor e tamanho)", `SELECT "productId", coalesce("colorHex",'') AS cor, coalesce("size",'') AS tamanho, count(*) AS n FROM "ProductVariant" GROUP BY 1,2,3 HAVING count(*) > 1`],
  ["VARIANTES SEM COR NEM TAMANHO", `SELECT count(*) AS n FROM "ProductVariant" WHERE "colorHex" IS NULL AND "size" IS NULL`],
  ["STOCK DO PRODUTO <> SOMA DAS VARIANTES ATIVAS", `SELECT p.id, p.name, p.stock, COALESCE(SUM(v.stock) FILTER (WHERE v.active),0)::int AS soma_variantes FROM "Product" p JOIN "ProductVariant" v ON v."productId"=p.id GROUP BY p.id, p.name, p.stock HAVING p.stock <> COALESCE(SUM(v.stock) FILTER (WHERE v.active),0)`],
  ["TAMANHOS MAIS USADOS", `SELECT "size", count(*) AS n FROM "ProductVariant" WHERE "size" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`],
  ["CORES MAIS USADAS", `SELECT "colorHex", count(*) AS n FROM "ProductVariant" WHERE "colorHex" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 15`],
  ["CATEGORIAS", `SELECT c.name, count(p.id) AS produtos FROM "Category" c LEFT JOIN "Product" p ON p."categoryId"=c.id GROUP BY c.name ORDER BY 2 DESC`]
];

try {
  await client.connect();
  for (const [title, sql] of checks) {
    const { rows } = await client.query(sql);
    console.log(`\n== ${title} (${rows.length})`);
    for (const row of rows) console.log(JSON.stringify(row));
  }
} catch (error) {
  console.error("Erro:", error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
