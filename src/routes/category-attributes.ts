import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma, RoleName } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { slugify } from "../services/catalog.js";

const adminOnly = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];

const typeSchema = z.enum(["TEXT", "NUMBER", "BOOLEAN", "SELECT", "MEASURE"]);
const optionsSchema = z.array(z.string().trim().min(1).max(60)).max(60);

const baseFields = {
  name: z.string().trim().min(2).max(60),
  required: z.boolean().default(false),
  showPublic: z.boolean().default(true),
  filterable: z.boolean().default(false),
  unit: z.string().trim().max(12).nullish(),
  options: optionsSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).default(0)
};

const createSchema = z.object({ ...baseFields, type: typeSchema }).superRefine((value, ctx) => {
  if (value.type === "SELECT" && (!value.options || value.options.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "SELECT precisa de pelo menos uma opção" });
  }
});

// O tipo não se muda depois de criado (os valores já guardados deixariam de fazer sentido): apaga-se e cria-se de novo.
const patchSchema = z.object({
  name: baseFields.name.optional(),
  required: z.boolean().optional(),
  showPublic: z.boolean().optional(),
  filterable: z.boolean().optional(),
  unit: z.string().trim().max(12).nullish(),
  options: optionsSchema.optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional()
});

const uniqueOptions = (options: string[]) => [...new Set(options.map((option) => option.trim()))];

// Características técnicas por categoria (Marca, RAM, Material…). O admin define-as; nada está fixo no código.
export async function categoryAttributeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/categories/:id/attributes", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const category = await prisma.category.findUnique({ where: { id: params.data.id }, select: { id: true } });
    if (!category) return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
    return prisma.categoryAttribute.findMany({ where: { categoryId: category.id }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  });

  app.post("/admin/categories/:id/attributes", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = createSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT", field: body.success ? undefined : body.error.issues[0]?.path.join(".") });
    const key = slugify(body.data.name);
    if (!key) return reply.code(400).send({ error: "INVALID_NAME" });
    const category = await prisma.category.findUnique({ where: { id: params.data.id }, select: { id: true } });
    if (!category) return reply.code(404).send({ error: "CATEGORY_NOT_FOUND" });
    try {
      const attribute = await prisma.categoryAttribute.create({
        data: {
          categoryId: category.id, name: body.data.name, key, type: body.data.type, required: body.data.required, showPublic: body.data.showPublic,
          filterable: body.data.filterable, unit: body.data.type === "MEASURE" ? body.data.unit ?? null : null,
          options: body.data.type === "SELECT" ? uniqueOptions(body.data.options ?? []) : [], sortOrder: body.data.sortOrder
        }
      });
      await audit({ actorId: request.auth!.userId, action: "CATEGORY_ATTRIBUTE_CREATED", entity: "CategoryAttribute", entityId: attribute.id });
      return reply.code(201).send(attribute);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return reply.code(409).send({ error: "ATTRIBUTE_ALREADY_EXISTS" });
      throw error;
    }
  });

  app.patch("/admin/category-attributes/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = patchSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const current = await prisma.categoryAttribute.findUnique({ where: { id: params.data.id } });
    if (!current) return reply.code(404).send({ error: "ATTRIBUTE_NOT_FOUND" });
    if (body.data.options && current.type !== "SELECT") return reply.code(400).send({ error: "INVALID_INPUT", field: "options" });
    if (current.type === "SELECT" && body.data.options && body.data.options.length === 0) return reply.code(400).send({ error: "INVALID_INPUT", field: "options" });
    try {
      const updated = await prisma.categoryAttribute.update({
        where: { id: current.id },
        data: {
          ...(body.data.name !== undefined ? { name: body.data.name } : {}),
          ...(body.data.required !== undefined ? { required: body.data.required } : {}),
          ...(body.data.showPublic !== undefined ? { showPublic: body.data.showPublic } : {}),
          ...(body.data.filterable !== undefined ? { filterable: body.data.filterable } : {}),
          ...(body.data.sortOrder !== undefined ? { sortOrder: body.data.sortOrder } : {}),
          ...(current.type === "MEASURE" && body.data.unit !== undefined ? { unit: body.data.unit ?? null } : {}),
          ...(body.data.options ? { options: uniqueOptions(body.data.options) } : {})
        }
      });
      await audit({ actorId: request.auth!.userId, action: "CATEGORY_ATTRIBUTE_UPDATED", entity: "CategoryAttribute", entityId: updated.id });
      return updated;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "ATTRIBUTE_NOT_FOUND" });
      throw error;
    }
  });

  // Apagar uma característica apaga também os valores que os produtos tinham nela (o ecrã avisa antes).
  app.delete("/admin/category-attributes/:id", { preHandler: adminOnly }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    try {
      await prisma.categoryAttribute.delete({ where: { id: params.data.id } });
      await audit({ actorId: request.auth!.userId, action: "CATEGORY_ATTRIBUTE_DELETED", entity: "CategoryAttribute", entityId: params.data.id });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return reply.code(404).send({ error: "ATTRIBUTE_NOT_FOUND" });
      throw error;
    }
  });
}
