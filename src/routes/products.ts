import type { FastifyInstance } from "fastify";
import { Prisma, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { deleteCloudinaryAsset } from "../services/cloudinary.js";

function slugify(value: string): string {
  return value.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

const variantSchema = z.object({
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  size: z.string().trim().min(1).max(30).optional(),
  stock: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(true)
});

// Base SEM defaults: serve de ponto de partida tanto para criar (com defaults) como para editar (parcial).
const productBaseSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).optional(),
  priceMzn: z.number().positive().max(10_000_000),
  stock: z.number().int().min(0).max(1_000_000),
  categoryId: z.string().min(1).optional(),
  active: z.boolean(),
  variants: z.array(variantSchema).max(200).optional()
});

const productWriteSchema = productBaseSchema.extend({
  stock: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true)
});

// Edição: campos opcionais e SEM defaults (um PATCH só com { active: false } não pode mexer no stock).
// description/categoryId aceitam null para poderem ser limpos.
const productPatchSchema = productBaseSchema.partial().extend({
  description: z.string().trim().max(4000).nullable().optional(),
  categoryId: z.string().min(1).nullable().optional()
});

const KNOWN_PRODUCT_ERRORS = new Set(["DUPLICATE_VARIANT", "VARIANT_ATTRIBUTE_REQUIRED", "INVALID_NAME"]);

function variantTotal(variants: Array<{ stock: number }>): number {
  return variants.reduce((sum, variant) => sum + variant.stock, 0);
}

function validateVariants(variants: Array<{ colorHex?: string; size?: string; stock: number; active?: boolean }>) {
  const keys = new Set<string>();
  for (const variant of variants) {
    if (!variant.colorHex && !variant.size) throw new Error("VARIANT_ATTRIBUTE_REQUIRED");
    const key = `${variant.colorHex ?? ""}|${variant.size ?? ""}`;
    if (keys.has(key)) throw new Error("DUPLICATE_VARIANT");
    keys.add(key);
  }
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get("/products", async (request) => {
    const q = z.object({ search: z.string().trim().max(100).optional(), categoryId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = { active: true, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { description: { contains: q.search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { where: { active: true }, orderBy: { createdAt: "asc" } } } }),
      prisma.product.count({ where })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.get("/products/:id", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const product = await prisma.product.findUnique({ where: { id: parsed.data.id }, include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { where: { active: true }, orderBy: { createdAt: "asc" } } } });
    if (!product || !product.active) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
    return product;
  });

  app.get("/categories", async () => {
    return prisma.category.findMany({ orderBy: { name: "asc" } });
  });

  // --- Admin ---
  app.patch("/admin/categories/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ name: z.string().trim().min(2).max(120) }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const slug = slugify(body.data.name);
    if (!slug) return reply.code(400).send({ error: "INVALID_NAME" });
    try {
      const category = await prisma.category.update({ where: { id: params.data.id }, data: { name: body.data.name, slug } });
      await audit({ actorId: request.auth!.userId, action: "CATEGORY_UPDATED", entity: "Category", entityId: category.id });
      return category;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "CATEGORY_ALREADY_EXISTS" });
      throw error;
    }
  });

  app.delete("/admin/categories/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const category = await prisma.category.findUnique({ where: { id: params.data.id }, include: { _count: { select: { products: true } } } });
      if (!category) return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
      if (category._count.products > 0) return reply.code(409).send({ error: "CATEGORY_HAS_PRODUCTS" });
      await prisma.category.delete({ where: { id: category.id } });
      await audit({ actorId: request.auth!.userId, action: "CATEGORY_DELETED", entity: "Category", entityId: category.id });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
      throw error;
    }
  });

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
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20), includeInactive: z.enum(["true", "false"]).default("true").transform((value) => value === "true"), search: z.string().trim().max(100).optional() }).parse(request.query);
    // z.coerce.boolean() tratava "false" como true (Boolean("false")), por isso o filtro nunca funcionava.
    const where = {
      ...(q.includeInactive ? {} : { active: true }),
      ...(q.search ? { name: { contains: q.search, mode: "insensitive" as const } } : {})
    };
    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { where: { active: true }, orderBy: { createdAt: "asc" } } } }),
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
      validateVariants(parsed.data.variants ?? []);
      const totalStock = parsed.data.variants?.length ? variantTotal(parsed.data.variants) : parsed.data.stock;
      const product = await prisma.product.create({
        data: {
          name: parsed.data.name, slug, description: parsed.data.description, priceMzn: new Prisma.Decimal(parsed.data.priceMzn),
          stock: totalStock, active: parsed.data.active, categoryId: parsed.data.categoryId,
          variants: parsed.data.variants?.length ? { create: parsed.data.variants } : undefined
        },
        include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { orderBy: { createdAt: "asc" } } }
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_CREATED", entity: "Product", entityId: product.id });
      return reply.code(201).send(product);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PRODUCT_CREATE_FAILED";
      if (message === "DUPLICATE_VARIANT" || message === "VARIANT_ATTRIBUTE_REQUIRED") return reply.code(400).send({ error: message });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "PRODUCT_ALREADY_EXISTS" });
      throw error;
    }
  });

  app.delete("/admin/products/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const product = await prisma.product.findUnique({ where: { id: params.data.id } });
      if (!product) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
      // As encomendas antigas guardam nome, preço e quantidade (OrderItem.productId passa a NULL, migração 006):
      // o histórico e as facturas não se perdem, por isso apagar é sempre permitido.
      await prisma.product.delete({ where: { id: product.id } });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_DELETED", entity: "Product", entityId: product.id });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
      // P2003 (chave estrangeira) só aparece se a migração 006 ainda não foi aplicada: o ecrã explica e oferece desactivar.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") return reply.code(409).send({ error: "PRODUCT_HAS_ORDERS" });
      throw error;
    }
  });

  app.post("/admin/products/bulk", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = z.object({ products: z.array(productWriteSchema).min(1).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const failed: Array<{ row: number; error: string }> = [];
    let created = 0;
    for (let i = 0; i < parsed.data.products.length; i++) {
      const item = parsed.data.products[i];
      try {
        validateVariants(item.variants ?? []);
        const slug = slugify(item.name);
        if (!slug) throw new Error("INVALID_NAME");
        const totalStock = item.variants?.length ? variantTotal(item.variants) : item.stock;
        await prisma.product.create({ data: { name: item.name, slug, description: item.description, priceMzn: new Prisma.Decimal(item.priceMzn), stock: totalStock, active: item.active, categoryId: item.categoryId, variants: item.variants?.length ? { create: item.variants } : undefined } });
        created++;
      } catch (error) {
        const message = error instanceof Error && KNOWN_PRODUCT_ERRORS.has(error.message)
          ? error.message
          : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
            ? "PRODUCT_ALREADY_EXISTS"
            : "IMPORT_FAILED";
        failed.push({ row: i + 2, error: message });
      }
    }
    await audit({ actorId: request.auth!.userId, action: "PRODUCT_BULK_IMPORTED", entity: "Product", metadata: { created, failed: failed.length } });
    return reply.send({ created, failed });
  });

  app.patch("/admin/products/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = productPatchSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const { variants, ...base } = body.data;
      if (variants) validateVariants(variants);
      const product = await prisma.$transaction(async (tx) => {
        const current = await tx.product.findUnique({ where: { id: params.data.id } });
        if (!current) throw new Error("PRODUCT_NOT_FOUND");
        const data: Prisma.ProductUncheckedUpdateInput = { ...base, priceMzn: base.priceMzn === undefined ? undefined : new Prisma.Decimal(base.priceMzn) };
        if (base.name) data.slug = slugify(base.name);
        if (variants) data.stock = variants.length ? variantTotal(variants) : (base.stock ?? 0);
        // Produto que tem variantes: o stock é a soma das variantes, um `stock` solto no PATCH não o pode sobrepor.
        else if (base.stock !== undefined && (await tx.productVariant.count({ where: { productId: current.id, active: true } })) > 0) delete data.stock;
        const updated = await tx.product.update({ where: { id: params.data.id }, data });
        if (variants) {
          // Sincroniza por (cor, tamanho) em vez de apagar e recriar: apagar punha OrderItem.variantId a NULL
          // (ON DELETE SET NULL) e os cancelamentos/reembolsos deixavam de repor o stock da variante.
          const keyOf = (v: { colorHex?: string | null; size?: string | null }) => `${v.colorHex ?? ""}|${v.size ?? ""}`;
          const existing = await tx.productVariant.findMany({ where: { productId: updated.id } });
          const byKey = new Map(existing.map((v) => [keyOf(v), v]));
          const incoming = new Set(variants.map(keyOf));
          for (const v of variants) {
            const match = byKey.get(keyOf(v));
            if (match) await tx.productVariant.update({ where: { id: match.id }, data: { stock: v.stock, active: v.active } });
            else await tx.productVariant.create({ data: { ...v, productId: updated.id } });
          }
          const removed = existing.filter((v) => !incoming.has(keyOf(v)));
          if (removed.length) await tx.productVariant.updateMany({ where: { id: { in: removed.map((v) => v.id) } }, data: { active: false, stock: 0 } });
        }
        return tx.product.findUniqueOrThrow({ where: { id: updated.id }, include: { category: true, images: { orderBy: { sortOrder: "asc" } }, variants: { orderBy: { createdAt: "asc" } } } });
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_UPDATED", entity: "Product", entityId: product.id, metadata: body.data });
      return product;
    } catch (error) {
      const message = error instanceof Error ? error.message : "PRODUCT_UPDATE_FAILED";
      if (message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: message });
      if (message === "DUPLICATE_VARIANT" || message === "VARIANT_ATTRIBUTE_REQUIRED") return reply.code(400).send({ error: message });
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "PRODUCT_ALREADY_EXISTS" });
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
      const current = await prisma.product.findUnique({ where: { id: params.data.id }, include: { variants: { where: { active: true } } } });
      if (!current) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
      if (current.variants.length > 0) return reply.code(409).send({ error: "VARIANT_STOCK_MANAGED_IN_FORM" });
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
    const body = z.object({ url: z.string().url().max(2000).refine((value) => value.toLowerCase().startsWith("https://"), "https only"), publicId: z.string().max(200).optional(), altText: z.string().max(200).optional(), isPrimary: z.boolean().default(false) }).safeParse(request.body);
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
    const image = await prisma.productImage.findFirst({ where: { id: params.data.imageId, productId: params.data.id } });
    if (!image) return reply.code(404).send({ error: "IMAGE_NOT_FOUND" });
    await prisma.$transaction(async (tx) => {
      await tx.productImage.delete({ where: { id: image.id } });
      // Se a apagada era a principal, a primeira que sobrar passa a sê-lo (antes o produto ficava sem principal).
      if (image.isPrimary) {
        const next = await tx.productImage.findFirst({ where: { productId: image.productId }, orderBy: { sortOrder: "asc" } });
        if (next) await tx.productImage.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    });
    if (image.publicId) deleteCloudinaryAsset(image.publicId).catch((error) => request.log.error(error, "cloudinary delete failed"));
    await audit({ actorId: request.auth!.userId, action: "PRODUCT_IMAGE_DELETED", entity: "Product", entityId: image.productId, metadata: { imageId: image.id } });
    return reply.code(204).send();
  });
}
