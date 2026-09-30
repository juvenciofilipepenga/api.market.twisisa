import { PrismaClient } from "../generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

// Ligação a uma base remota (ex.: Neon) a partir de uma rede lenta ou de um telemóvel: o primeiro
// pedido depois de a base "adormecer" pode demorar vários segundos. Por isso os limites de espera
// são mais generosos do que os padrão do Prisma (2 s para arrancar e 5 s para concluir uma transação),
// que causavam o erro P2028 "Unable to start a transaction in the given time".
const adapter = new PrismaPg({
  connectionString,
  connectionTimeoutMillis: 15_000,
  idleTimeoutMillis: 30_000
});

export const prisma = new PrismaClient({
  adapter,
  transactionOptions: { maxWait: 10_000, timeout: 20_000 }
});

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
