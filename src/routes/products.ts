import type { FastifyInstance } from "fastify";
import { Prisma, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";

function slugify(value: string): string {
  return value.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

const productWriteSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).optional(),
  priceMzn: z.number().positive().max(10_000_000),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  categoryId: z.string().min(1).optional(),
  active: z.boolean().default(true)
});

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get("/products", async (request) => {
    const q = z.object({ search: z.string().trim().max(100).optional(), categoryId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = { active: true, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { description: { contains: q.search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: { category: true, images: { orderBy: { sortOrder: "asc" } } } }),
      prisma.product.count({ where })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.get("/products/:id", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const product = await prisma.product.findUnique({ where: { id: parsed.data.id }, include: { category: true, images: { orderBy: { sortOrder: "asc" } } } });
    if (!product || !product.active) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
    return product;
  });

  app.get("/categories", async () => {
    return prisma.category.findMany({ orderBy: { name: "asc" } });
  });

  // --- Admin ---
  app.post("/admin/categories", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const slug = slugify(parsed.data.name);
    if (!slug) return reply.code(400).send({ error: "INVALID_NAME" });
    try {
      const category = await prisma.category.create({ data: { name: parsed.data.name, slug } });
      return reply.code(201).send(category);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "CATEGORY_ALREADY_EXISTS" });
      throw error;
    }
  });

  app.get("/admin/products", { preHandler: adminOnly }, async (request) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), includeInactive: z.coerce.boolean().default(true) }).parse(request.query);
    const where = q.includeInactive ? {} : { active: true };
    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: { category: true, images: { orderBy: { sortOrder: "asc" } } } }),
      prisma.product.count({ where })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.post("/admin/products", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = productWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const slug = slugify(parsed.data.name);
    if (!slug) return reply.code(400).send({ error: "INVALID_NAME" });
    try {
      const product = await prisma.product.create({
        data: {
          name: parsed.data.name,
          slug,
          description: parsed.data.description,
          priceMzn: new Prisma.Decimal(parsed.data.priceMzn),
          stock: parsed.data.stock,
          active: parsed.data.active,
          categoryId: parsed.data.categoryId
        }
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_CREATED", entity: "Product", entityId: product.id });
      return reply.code(201).send(product);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "PRODUCT_ALREADY_EXISTS" });
      throw error;
    }
  });

  app.patch("/admin/products/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = productWriteSchema.partial().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const data: Prisma.ProductUncheckedUpdateInput = { ...body.data, priceMzn: body.data.priceMzn === undefined ? undefined : new Prisma.Decimal(body.data.priceMzn) };
    if (body.data.name) data.slug = slugify(body.data.name);
    try {
      const product = await prisma.product.update({ where: { id: params.data.id }, data });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_UPDATED", entity: "Product", entityId: product.id, metadata: body.data });
      return product;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
      throw error;
    }
  });

  // Ajuste explícito de stock (delta positivo ou negativo), separado do PATCH geral para deixar rasto de auditoria próprio.
  app.post("/admin/products/:id/stock", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ delta: z.number().int().refine((v) => v !== 0, "delta must not be zero") }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const product = await prisma.$transaction(async (tx) => {
        if (body.data.delta < 0) {
          const updated = await tx.product.updateMany({ where: { id: params.data.id, stock: { gte: -body.data.delta } }, data: { stock: { increment: body.data.delta } } });
          if (updated.count === 0) throw new Error("INSUFFICIENT_STOCK");
        } else {
          const updated = await tx.product.updateMany({ where: { id: params.data.id }, data: { stock: { increment: body.data.delta } } });
          if (updated.count === 0) throw new Error("PRODUCT_NOT_FOUND");
        }
        return tx.product.findUniqueOrThrow({ where: { id: params.data.id } });
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_STOCK_ADJUSTED", entity: "Product", entityId: product.id, metadata: { delta: body.data.delta } });
      return product;
    } catch (error) {
      const message = error instanceof Error ? error.message : "STOCK_UPDATE_FAILED";
      return reply.code(message === "INSUFFICIENT_STOCK" ? 409 : message === "PRODUCT_NOT_FOUND" ? 404 : 500).send({ error: message });
    }
  });

  // Liga uma imagem já carregada via POST /media/image a um produto.
  app.post("/admin/products/:id/images", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ url: z.string().url().max(2000), publicId: z.string().max(200).optional(), altText: z.string().max(200).optional(), isPrimary: z.boolean().default(false) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const product = await prisma.product.findUnique({ where: { id: params.data.id } });
    if (!product) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
    const image = await prisma.$transaction(async (tx) => {
      if (body.data.isPrimary) await tx.productImage.updateMany({ where: { productId: product.id }, data: { isPrimary: false } });
      const count = await tx.productImage.count({ where: { productId: product.id } });
      return tx.productImage.create({ data: { productId: product.id, url: body.data.url, publicId: body.data.publicId, altText: body.data.altText, isPrimary: body.data.isPrimary || count === 0, sortOrder: count } });
    });
    return reply.code(201).send(image);
  });

  app.delete("/admin/products/:id/images/:imageId", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1), imageId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const result = await prisma.productImage.deleteMany({ where: { id: params.data.imageId, productId: params.data.id } });
    if (result.count === 0) return reply.code(404).send({ error: "IMAGE_NOT_FOUND" });
    return reply.code(204).send();
  });
}
