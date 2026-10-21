import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { groqConfigured } from "../config/env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { DEFAULT_ASSISTANT_NAME, generateAiReply, loadAiSettings } from "../services/chatBot.js";

const adminGuard = [requireAuth, requirePermission("support.manage")];
const MAX_KNOWLEDGE_ENTRIES = 300;

const settingsSchema = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().min(1).max(60),
  instructions: z.string().max(4000)
});
const knowledgeSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(2000),
  active: z.boolean().optional()
});
const idParams = z.object({ id: z.string().min(1) });

// "Treinar" a IA do chat: instruções + conhecimento da loja, enviados ao Groq em cada resposta (ver services/chatKnowledge.ts).
export async function chatAiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/chat/ai/settings", { preHandler: adminGuard }, async () => {
    const [settings, knowledgeCount] = await Promise.all([loadAiSettings(), prisma.chatKnowledge.count({ where: { active: true } })]);
    return { settings, groqConfigured, knowledgeCount };
  });

  app.put("/admin/chat/ai/settings", { preHandler: adminGuard }, async (request, reply) => {
    const body = settingsSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const data = { ...body.data, updatedById: request.auth!.userId };
    await prisma.chatAiSettings.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
    await audit({ actorId: request.auth!.userId, action: "CHAT_AI_SETTINGS_UPDATED", entity: "ChatAiSettings", entityId: "default" });
    return { settings: { enabled: body.data.enabled, assistantName: body.data.assistantName || DEFAULT_ASSISTANT_NAME, instructions: body.data.instructions } };
  });

  app.get("/admin/chat/ai/knowledge", { preHandler: adminGuard }, async () => {
    const data = await prisma.chatKnowledge.findMany({ orderBy: [{ active: "desc" }, { updatedAt: "desc" }], take: MAX_KNOWLEDGE_ENTRIES });
    return { data };
  });

  app.post("/admin/chat/ai/knowledge", { preHandler: adminGuard }, async (request, reply) => {
    const body = knowledgeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    if ((await prisma.chatKnowledge.count()) >= MAX_KNOWLEDGE_ENTRIES) return reply.code(409).send({ error: "KNOWLEDGE_LIMIT_REACHED" });
    const entry = await prisma.chatKnowledge.create({ data: { title: body.data.title, content: body.data.content, active: body.data.active ?? true, createdById: request.auth!.userId } });
    await audit({ actorId: request.auth!.userId, action: "CHAT_KNOWLEDGE_CREATED", entity: "ChatKnowledge", entityId: entry.id });
    return reply.code(201).send({ entry });
  });

  app.patch("/admin/chat/ai/knowledge/:id", { preHandler: adminGuard }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = knowledgeSchema.partial().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const entry = await prisma.chatKnowledge.update({ where: { id: params.data.id }, data: body.data }).catch(() => null);
    if (!entry) return reply.code(404).send({ error: "KNOWLEDGE_NOT_FOUND" });
    await audit({ actorId: request.auth!.userId, action: "CHAT_KNOWLEDGE_UPDATED", entity: "ChatKnowledge", entityId: entry.id });
    return { entry };
  });

  app.delete("/admin/chat/ai/knowledge/:id", { preHandler: adminGuard }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const entry = await prisma.chatKnowledge.delete({ where: { id: params.data.id } }).catch(() => null);
    if (!entry) return reply.code(404).send({ error: "KNOWLEDGE_NOT_FOUND" });
    await audit({ actorId: request.auth!.userId, action: "CHAT_KNOWLEDGE_DELETED", entity: "ChatKnowledge", entityId: entry.id });
    return reply.code(204).send();
  });

  // Experimentar a IA com as instruções e o conhecimento gravados, sem dados de nenhuma conta de cliente.
  app.post("/admin/chat/ai/test", { preHandler: adminGuard, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = z.object({ message: z.string().trim().min(1).max(1000) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const settings = await loadAiSettings();
    // Mesmo com a IA desligada para clientes, o teste corre (é para o admin afinar antes de ligar).
    const result = await generateAiReply({ userId: null, text: body.data.message, history: [{ role: "user", content: body.data.message }], settings: { ...settings, enabled: true } });
    return { reply: result.reply, escalate: result.escalate, usedKnowledge: result.usedKnowledge, failure: result.failure ?? null, groqConfigured };
  });
}
