import type { FastifyInstance } from "fastify";
import { Prisma, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { deleteCloudinaryAsset } from "../services/cloudinary.js";
import { computePricing, type PricingInput } from "../services/pricing.js";
import { availableStock, CatalogError, describeOptions, normalizeVariants, optionsFromLegacy, parseAttributeValue, type NormalizedVariant, type VariantOptions } from "../services/catalog.js";

function slugify(value: string): string {
  return value.trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

// Aceita o formato novo (options: {"Cor":"#000","Tamanho":"M"}) e o antigo (colorHex/size), para não partir o que já existe.
const variantSchema = z.object({
  colorHex: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  size: z.string().trim().min(1).max(30).nullish(),
  options: z.record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(60)).optional(),
  sku: z.string().trim().max(60).nullish(),
  // Vazio = herda o preço do produto.
  priceMzn: z.number().positive().max(10_000_000).nullish(),
  stock: z.number().int().min(0).max(1_000_000),
  active: z.boolean().default(true)
});

const attributeInputSchema = z.object({
  attributeId: z.string().min(1),
  value: z.union([z.string().max(300), z.number(), z.boolean(), z.null()])
});

// Calculadora de preço: o preço do produto é CALCULADO destes valores (services/pricing.ts), nunca escrito à mão.
const pricingInputSchema = z.object({
  purchaseMzn: z.number().positive().max(10_000_000),
  taxPct: z.number().min(0).max(100).default(0),
  transportMzn: z.number().min(0).max(10_000_000).default(0),
  otherCostsMzn: z.number().min(0).max(10_000_000).default(0),
  returnPct: z.number().min(0).max(1000),
  commissionPct: z.number().min(0).max(60).default(0),
  // Tecto de 50% de desconto, validado aqui (o cliente pode pedir mais; o servidor recusa).
  discountPct: z.number().min(0).max(50).default(0)
});

// Base SEM defaults: serve de ponto de partida tanto para criar (com defaults) como para editar (parcial).
const productBaseSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(4000).optional(),
  // Com `pricing`, o preço é calculado no servidor e este valor é ignorado. Sem `pricing` (importações antigas) vale como está.
  priceMzn: z.number().positive().max(10_000_000).optional(),
  pricing: pricingInputSchema.optional(),
  stock: z.number().int().min(0).max(1_000_000),
  categoryId: z.string().min(1).optional(),
  active: z.boolean(),
  variants: z.array(variantSchema).max(200).optional(),
  attributes: z.array(attributeInputSchema).max(80).optional()
});

const productWriteSchema = productBaseSchema.extend({
  stock: z.number().int().min(0).max(1_000_000).default(0),
  active: z.boolean().default(true)
}).refine((p) => p.pricing !== undefined || p.priceMzn !== undefined, { message: "pricing or priceMzn required" });

// Edição: campos opcionais e SEM defaults (um PATCH só com { active: false } não pode mexer no stock).
// description/categoryId aceitam null para poderem ser limpos.
const productPatchSchema = productBaseSchema.partial().extend({
  description: z.string().trim().max(4000).nullable().optional(),
  categoryId: z.string().min(1).nullable().optional()
});

const CATALOG_INPUT_ERRORS = new Set(["DUPLICATE_VARIANT", "VARIANT_ATTRIBUTE_REQUIRED", "DUPLICATE_SKU", "TOO_MANY_OPTIONS", "ATTRIBUTE_REQUIRED", "ATTRIBUTE_INVALID_VALUE", "ATTRIBUTE_NOT_IN_CATEGORY"]);
const KNOWN_PRODUCT_ERRORS = new Set([...CATALOG_INPUT_ERRORS, "INVALID_NAME", "INVALID_PRICE"]);

// Variantes: SÓ as ativas nas listas públicas e no detalhe; o admin recebe todas na resposta de gravação.
const PRODUCT_INCLUDE = { category: true, images: { orderBy: { sortOrder: "asc" as const } }, variants: { where: { active: true }, orderBy: { createdAt: "asc" as const } }, attributeValues: { include: { attribute: true } } };
const ADMIN_WRITE_INCLUDE = { pricing: true, category: true, images: { orderBy: { sortOrder: "asc" as const } }, variants: { orderBy: { createdAt: "asc" as const } }, attributeValues: { include: { attribute: true } } };

type AttributeInput = z.infer<typeof attributeInputSchema>;

// Preço final do produto: calculado a partir dos custos (o que o cliente paga já com o desconto), ou o valor dado (legado, sem custos).
// null = fora dos limites.
function resolvePrice(input: { pricing?: PricingInput; priceMzn?: number }): number | null {
  const price = input.pricing ? computePricing(input.pricing).customerPrice : input.priceMzn;
  return price !== undefined && price > 0 && price <= 10_000_000 ? price : null;
}

const pricingData = (p: PricingInput) => ({
  purchaseMzn: p.purchaseMzn, taxPct: p.taxPct, transportMzn: p.transportMzn, otherCostsMzn: p.otherCostsMzn,
  returnPct: p.returnPct, commissionPct: p.commissionPct, discountPct: p.discountPct
});

interface PresentableProduct {
  priceMzn: Prisma.Decimal;
  stock: number;
  variants: Array<{ stock: number; active: boolean; priceMzn: Prisma.Decimal | null; options: Prisma.JsonValue; colorHex: string | null; size: string | null }>;
  attributeValues: Array<{
    valueText: string | null; valueNumber: Prisma.Decimal | null; valueBool: boolean | null;
    attribute: { id: string; key: string; name: string; type: string; unit: string | null; options: Prisma.JsonValue; required: boolean; showPublic: boolean; filterable: boolean; sortOrder: number };
  }>;
}

// Uma só forma de apresentar um produto. Calcula o que NÃO se guarda duplicado:
//  - stock: soma das variantes ativas (ou o do produto, se não tem variantes);
//  - effectivePriceMzn por variante: o da variante ou, se vazio, o do produto;
//  - optionDefs: as opções que o cliente pode escolher, deduzidas das variantes reais.
function present<P extends PresentableProduct>(product: P, publicOnly: boolean) {
  // Custos e margens só saem para o admin; mesmo que alguém acrescente `pricing` ao include público, é cortado aqui.
  const { attributeValues, pricing, ...rest } = product as P & { pricing?: unknown };
  const variants = product.variants.map((variant) => {
    const raw = variant.options && typeof variant.options === "object" && !Array.isArray(variant.options) ? (variant.options as VariantOptions) : {};
    const options = Object.keys(raw).length ? raw : optionsFromLegacy(variant.colorHex, variant.size);
    return { ...variant, options, effectivePriceMzn: variant.priceMzn ?? product.priceMzn };
  });
  const active = variants.filter((variant) => variant.active);
  const priceFromMzn = active.reduce((min, variant) => (Number(variant.effectivePriceMzn) < Number(min) ? variant.effectivePriceMzn : min), product.priceMzn);
  const attributes = attributeValues
    .filter((row) => !publicOnly || row.attribute.showPublic)
    .sort((a, b) => a.attribute.sortOrder - b.attribute.sortOrder || a.attribute.name.localeCompare(b.attribute.name))
    .map((row) => ({
      id: row.attribute.id, key: row.attribute.key, name: row.attribute.name, type: row.attribute.type, unit: row.attribute.unit,
      options: row.attribute.options, required: row.attribute.required, showPublic: row.attribute.showPublic, filterable: row.attribute.filterable,
      value: row.valueText ?? (row.valueNumber !== null ? Number(row.valueNumber) : row.valueBool)
    }));
  return { ...rest, ...(publicOnly ? {} : { pricing: pricing ?? null }), variants, stock: availableStock({ stock: product.stock, variants }), priceFromMzn, optionDefs: describeOptions(active), attributes };
}

function variantCreateData(variant: NormalizedVariant) {
  return {
    colorHex: variant.colorHex, size: variant.size, options: variant.options, optionKey: variant.optionKey, sku: variant.sku,
    priceMzn: variant.priceMzn === null ? null : new Prisma.Decimal(variant.priceMzn), stock: variant.stock, active: variant.active
  };
}

// Valores das características do produto. Sem `attributes` no pedido não se mexe nos valores existentes; com valor vazio apaga-se.
async function saveAttributes(
  tx: Prisma.TransactionClient, productId: string, categoryId: string | null, inputs: AttributeInput[] | undefined,
  ctx: { categoryTouched: boolean; enforceRequired: boolean; active: boolean }
) {
  if (!inputs && !ctx.categoryTouched) return;
  // Características de OUTRA categoria deixam de fazer sentido quando o produto muda de categoria.
  await tx.productAttributeValue.deleteMany({ where: { productId, ...(categoryId ? { attribute: { categoryId: { not: categoryId } } } : {}) } });
  const defs = categoryId ? await tx.categoryAttribute.findMany({ where: { categoryId } }) : [];
  const byId = new Map(defs.map((def) => [def.id, def]));
  for (const input of inputs ?? []) {
    const def = byId.get(input.attributeId);
    if (!def) throw new CatalogError("ATTRIBUTE_NOT_IN_CATEGORY");
    const parsed = parseAttributeValue(def, input.value);
    if (!parsed) { await tx.productAttributeValue.deleteMany({ where: { productId, attributeId: def.id } }); continue; }
    await tx.productAttributeValue.upsert({
      where: { productId_attributeId: { productId, attributeId: def.id } },
      create: { productId, attributeId: def.id, ...parsed },
      update: parsed
    });
  }
  if (ctx.enforceRequired && ctx.active) {
    const have = new Set((await tx.productAttributeValue.findMany({ where: { productId }, select: { attributeId: true } })).map((row) => row.attributeId));
    const missing = defs.find((def) => def.required && !have.has(def.id));
    if (missing) throw new CatalogError("ATTRIBUTE_REQUIRED", missing.name);
  }
}

// Erros de catálogo → resposta HTTP. Devolve true se tratou o erro.
function replyCatalogError(error: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  if (error instanceof CatalogError && CATALOG_INPUT_ERRORS.has(error.code)) {
    reply.code(400).send({ error: error.code, ...(error.detail ? { attribute: error.detail } : {}) });
    return true;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = JSON.stringify(error.meta?.target ?? "").toLowerCase();
    if (target.includes("sku")) { reply.code(409).send({ error: "SKU_ALREADY_EXISTS" }); return true; }
    if (target.includes("optionkey")) { reply.code(409).send({ error: "DUPLICATE_VARIANT" }); return true; }
    reply.code(409).send({ error: "PRODUCT_ALREADY_EXISTS" });
    return true;
  }
  return false;
}

export async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get("/products", async (request) => {
    const q = z.object({ search: z.string().trim().max(100).optional(), categoryId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = { active: true, ...(q.categoryId ? { categoryId: q.categoryId } : {}), ...(q.search ? { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { description: { contains: q.search, mode: "insensitive" as const } }] } : {}) };
    const [data, total] = await Promise.all([
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: PRODUCT_INCLUDE }),
      prisma.product.count({ where })
    ]);
    return { data: data.map((product) => present(product, true)), pagination: { page: q.page, limit: q.limit, total } };
  });

  app.get("/products/:id", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const product = await prisma.product.findUnique({ where: { id: parsed.data.id }, include: PRODUCT_INCLUDE });
    if (!product || !product.active) return reply.code(404).send({ error: "PRODUCT_NOT_FOUND" });
    return present(product, true);
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
      prisma.product.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { createdAt: "desc" }, include: ADMIN_WRITE_INCLUDE }),
      prisma.product.count({ where })
    ]);
    return { data: data.map((product) => present(product, false)), pagination: { page: q.page, limit: q.limit, total } };
  });

  app.post("/admin/products", { preHandler: adminOnly }, async (request, reply) => {
    const parsed = productWriteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const slug = slugify(parsed.data.name);
    if (!slug) return reply.code(400).send({ error: "INVALID_NAME" });
    const price = resolvePrice(parsed.data);
    if (price === null) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      const variants = parsed.data.variants?.length ? normalizeVariants(parsed.data.variants) : [];
      const product = await prisma.$transaction(async (tx) => {
        const created = await tx.product.create({
          data: {
            name: parsed.data.name, slug, description: parsed.data.description, priceMzn: new Prisma.Decimal(price),
            // Com variantes o stock vive nelas (a API calcula o total); o do produto só conta para produtos simples.
            stock: variants.length ? 0 : parsed.data.stock, active: parsed.data.active, categoryId: parsed.data.categoryId,
            variants: variants.length ? { create: variants.map(variantCreateData) } : undefined
          }
        });
        if (parsed.data.pricing) await tx.productPricing.create({ data: { productId: created.id, ...pricingData(parsed.data.pricing) } });
        await saveAttributes(tx, created.id, created.categoryId, parsed.data.attributes, { categoryTouched: true, enforceRequired: true, active: created.active });
        return tx.product.findUniqueOrThrow({ where: { id: created.id }, include: ADMIN_WRITE_INCLUDE });
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_CREATED", entity: "Product", entityId: product.id });
      return reply.code(201).send(present(product, false));
    } catch (error) {
      if (replyCatalogError(error, reply)) return;
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
        const variants = item.variants?.length ? normalizeVariants(item.variants) : [];
        const slug = slugify(item.name);
        if (!slug) throw new Error("INVALID_NAME");
        const price = resolvePrice(item);
        if (price === null) throw new Error("INVALID_PRICE");
        await prisma.$transaction(async (tx) => {
          const row = await tx.product.create({ data: { name: item.name, slug, description: item.description, priceMzn: new Prisma.Decimal(price), stock: variants.length ? 0 : item.stock, active: item.active, categoryId: item.categoryId, variants: variants.length ? { create: variants.map(variantCreateData) } : undefined } });
          if (item.pricing) await tx.productPricing.create({ data: { productId: row.id, ...pricingData(item.pricing) } });
        });
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
      const { variants: variantInputs, attributes, pricing, ...base } = body.data;
      const variants = variantInputs ? normalizeVariants(variantInputs) : undefined;
      // Com custos, o preço é recalculado aqui e o `priceMzn` que vier no pedido é ignorado.
      const price = pricing || base.priceMzn !== undefined ? resolvePrice({ pricing, priceMzn: base.priceMzn }) : undefined;
      if (price === null) return reply.code(400).send({ error: "INVALID_INPUT" });
      const product = await prisma.$transaction(async (tx) => {
        const current = await tx.product.findUnique({ where: { id: params.data.id } });
        if (!current) throw new Error("PRODUCT_NOT_FOUND");
        const data: Prisma.ProductUncheckedUpdateInput = { ...base, priceMzn: price === undefined ? undefined : new Prisma.Decimal(price) };
        if (base.name) data.slug = slugify(base.name);
        // Com variantes o stock vive nelas (o produto guarda 0 e a API calcula o total). Sem variantes, o stock é do produto.
        if (variants) data.stock = variants.length ? 0 : (base.stock ?? 0);
        // Produto que tem variantes: um `stock` solto no PATCH não pode sobrepor o das variantes.
        else if (base.stock !== undefined && (await tx.productVariant.count({ where: { productId: current.id, active: true } })) > 0) delete data.stock;
        const updated = await tx.product.update({ where: { id: params.data.id }, data });
        if (pricing) await tx.productPricing.upsert({ where: { productId: updated.id }, create: { productId: updated.id, ...pricingData(pricing) }, update: pricingData(pricing) });
        if (variants) {
          // Sincroniza pela chave canónica das opções em vez de apagar e recriar: apagar punha OrderItem.variantId a NULL
          // (ON DELETE SET NULL) e os cancelamentos/reembolsos deixavam de repor o stock da variante.
          const existing = await tx.productVariant.findMany({ where: { productId: updated.id } });
          const byKey = new Map<string, (typeof existing)[number]>();
          for (const v of existing) {
            const key = v.optionKey ?? "";
            const seen = byKey.get(key);
            if (!seen || (!seen.active && v.active)) byKey.set(key, v); // havendo duas, vale a ativa
          }
          const incoming = new Set(variants.map((v) => v.optionKey));
          for (const v of variants) {
            const match = byKey.get(v.optionKey);
            if (match) await tx.productVariant.update({ where: { id: match.id }, data: variantCreateData(v) });
            else await tx.productVariant.create({ data: { ...variantCreateData(v), productId: updated.id } });
          }
          const removed = existing.filter((v) => v.active && !incoming.has(v.optionKey ?? ""));
          if (removed.length) await tx.productVariant.updateMany({ where: { id: { in: removed.map((v) => v.id) } }, data: { active: false, stock: 0 } });
        }
        await saveAttributes(tx, updated.id, updated.categoryId, attributes, { categoryTouched: base.categoryId !== undefined, enforceRequired: attributes !== undefined, active: updated.active });
        return tx.product.findUniqueOrThrow({ where: { id: updated.id }, include: ADMIN_WRITE_INCLUDE });
      });
      await audit({ actorId: request.auth!.userId, action: "PRODUCT_UPDATED", entity: "Product", entityId: product.id, metadata: body.data });
      return present(product, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PRODUCT_UPDATE_FAILED";
      if (message === "PRODUCT_NOT_FOUND") return reply.code(404).send({ error: message });
      if (replyCatalogError(error, reply)) return;
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
