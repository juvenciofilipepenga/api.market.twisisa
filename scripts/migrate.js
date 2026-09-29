import "dotenv/config";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationsDir = join(root, "migrations");
const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function files() {
  return (await readdir(migrationsDir)).filter((file) => /^\d+_.+\.js$/.test(file)).sort();
}
async function checksum(file) {
  return createHash("sha256").update(await readFile(join(migrationsDir, file))).digest("hex");
}
async function connect() {
  return new Client({ connectionString: databaseUrl, ssl: databaseUrl.includes("neon.tech") ? { rejectUnauthorized: false } : undefined });
}
async function ensureTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS "_schema_migrations" ("id" SERIAL PRIMARY KEY, "name" TEXT NOT NULL UNIQUE, "checksum" TEXT NOT NULL, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}
async function load(file) {
  return import(pathToFileURL(join(migrationsDir, file)).href);
}

const command = process.argv[2] ?? "up";
const client = await connect();
try {
  await client.connect();
  await ensureTable(client);
  const names = await files();
  const applied = await client.query(`SELECT "name", "checksum", "appliedAt" FROM "_schema_migrations" ORDER BY "id"`);
  const map = new Map(applied.rows.map((row) => [row.name, row]));

  if (command === "status") {
    for (const file of names) {
      const row = map.get(file);
      if (!row) console.log(`PENDING  ${file}`);
      else console.log(`${row.checksum === await checksum(file) ? "APPLIED" : "CHANGED"}  ${file}  ${row.appliedAt.toISOString()}`);
    }
    process.exitCode = 0;
  } else if (command === "rollback") {
    const last = applied.rows.at(-1);
    if (!last) console.log("No migrations to rollback.");
    else {
      const migration = await load(last.name);
      await client.query("BEGIN");
      try { await migration.down(client); await client.query(`DELETE FROM "_schema_migrations" WHERE "name" = $1`, [last.name]); await client.query("COMMIT"); console.log(`Rolled back ${last.name}`); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } else if (command === "up") {
    for (const file of names) {
      const currentChecksum = await checksum(file);
      const existing = map.get(file);
      if (existing) {
        if (existing.checksum !== currentChecksum) throw new Error(`Migration checksum changed: ${file}`);
        continue;
      }
      const migration = await load(file);
      if (typeof migration.up !== "function") throw new Error(`Migration ${file} must export up(client)`);
      console.log(`Applying ${file}...`);
      await client.query("BEGIN");
      try { await migration.up(client); await client.query(`INSERT INTO "_schema_migrations" ("name","checksum") VALUES ($1,$2)`, [file, currentChecksum]); await client.query("COMMIT"); console.log(`Applied ${file}`); }
      catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} finally {
  await client.end();
}
