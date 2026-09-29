import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, RoleName } from "../src/generated/prisma/client.js";
import bcrypt from "bcryptjs";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

const adapter = new PrismaPg({
  connectionString,
});

const prisma = new PrismaClient({
  adapter,
});

async function main(): Promise<void> {
  for (const name of [RoleName.CUSTOMER, RoleName.ADMIN, RoleName.SUPER_ADMIN]) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  const superAdmin = await prisma.role.findUniqueOrThrow({
    where: { name: RoleName.SUPER_ADMIN },
  });

  if (process.env.NODE_ENV === "production") {
    console.log(
      "NODE_ENV=production: seed ignorado (nenhum utilizador nem produto de exemplo é criado).",
    );
    return;
  }

  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "ChangeMe123!";
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  await prisma.user.upsert({
    where: { email: "admin@twisisa.local" },
    update: {},
    create: {
      email: "admin@twisisa.local",
      name: "Twisisa Admin",
      passwordHash,
      roles: {
        create: {
          roleId: superAdmin.id,
        },
      },
    },
  });

  const category = await prisma.category.upsert({
    where: { slug: "eletronica" },
    update: {},
    create: {
      name: "Eletrónica",
      slug: "eletronica",
    },
  });

  await prisma.product.upsert({
    where: { slug: "produto-teste" },
    update: {},
    create: {
      name: "Produto Teste",
      slug: "produto-teste",
      description: "Produto inicial para testes.",
      priceMzn: 1000,
      stock: 10,
      categoryId: category.id,
    },
  });

  console.log(
    `Seed concluído (dev/test). Admin: admin@twisisa.local / ${
      process.env.SEED_ADMIN_PASSWORD ? "(SEED_ADMIN_PASSWORD)" : adminPassword
    }`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
