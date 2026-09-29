import type { FastifyInstance, FastifyRequest } from "fastify";
import { ChatSenderType, ConversationStatus, RoleName } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { isAdmin, requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { uploadChatAttachment } from "../services/cloudinary.js";
import { greetingMessage, handleCustomerMessage, MENU_OPTIONS } from "../services/chatBot.js";
import { emitChatEvent } from "../services/realtime.js";
import { notifyAdmins, notifyUser } from "../services/notifications.js";

const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const HISTORY_LIMIT = 12;

type PendingAttachment = { url: string; publicId?: string; mimeType: string; sizeBytes: number };

async function collectMessageParts(request: FastifyRequest): Promise<{ content: string | undefined; attachments: PendingAttachment[] }> {
  if (!request.isMultipart()) {
    const parsed = z.object({ content: z.string().trim().min(1).max(4000).optional() }).safeParse(request.body);
    return { content: parsed.success ? parsed.data.content : undefined, attachments: [] };
  }
  let content: string | undefined;
  const attachments: PendingAttachment[] = [];
  for await (const part of request.parts()) {
    if (part.type === "field" && part.fieldname === "content" && typeof part.value === "string") {
      content = part.value.trim();
    } else if (part.type === "file") {
      if (!ALLOWED_ATTACHMENT_TYPES.has(part.mimetype)) {
        part.file.resume();
        throw new Error("UNSUPPORTED_FILE_TYPE");
      }
      const buffer = await part.toBuffer();
      if (buffer.length === 0) continue;
      if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("FILE_TOO_LARGE");
      const result = await uploadChatAttachment(buffer, part.mimetype);
      attachments.push({
        url: String(result.secure_url ?? result.url),
        publicId: typeof result.public_id === "string" ? result.public_id : undefined,
        mimeType: part.mimetype,
        sizeBytes: buffer.length
      });
    }
  }
  return { content, attachments };
}

async function loadHistory(conversationId: string) {
  const messages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT
  });
  return messages
    .reverse()
    .filter((message) => message.content)
    .map((message) => ({ role: message.senderType === ChatSenderType.CUSTOMER ? ("user" as const) : ("assistant" as const), content: message.content! }));
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // Devolve a conversa em curso do cliente (cria uma nova com a saudação do bot, se não existir nenhuma aberta).
  app.post("/chat/conversations", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    let conversation = await prisma.conversation.findFirst({
      where: { userId, status: { in: [ConversationStatus.BOT, ConversationStatus.ESCALATED] } },
      orderBy: { lastMessageAt: "desc" }
    });
    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          userId,
          messages: { create: { senderType: ChatSenderType.BOT, content: greetingMessage() } }
        }
      });
    }
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, include: { attachments: true } });
    return { conversation, messages, menu: MENU_OPTIONS };
  });

  app.get("/chat/conversations", { preHandler: requireAuth }, async (request) => {
    const conversations = await prisma.conversation.findMany({ where: { userId: request.auth!.userId }, orderBy: { lastMessageAt: "desc" }, take: 20 });
    return { data: conversations };
  });

  app.get("/chat/conversations/:id/messages", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
    if (conversation.userId !== request.auth!.userId && !isAdmin(request.auth!.roles)) return reply.code(403).send({ error: "FORBIDDEN" });
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, include: { attachments: true } });
    return { conversation, messages };
  });

  // Cliente envia mensagem (texto e/ou anexos). O bot responde de imediato, salvo se já estiver escalado.
  app.post("/chat/conversations/:id/messages", { preHandler: requireAuth }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
    if (conversation.userId !== request.auth!.userId) return reply.code(403).send({ error: "FORBIDDEN" });
    if (conversation.status === ConversationStatus.CLOSED) return reply.code(409).send({ error: "CONVERSATION_CLOSED" });

    let parts: Awaited<ReturnType<typeof collectMessageParts>>;
    try {
      parts = await collectMessageParts(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ATTACHMENT_UPLOAD_FAILED";
      return reply.code(message === "UNSUPPORTED_FILE_TYPE" ? 415 : message === "FILE_TOO_LARGE" ? 413 : 502).send({ error: message });
    }
    if (!parts.content && parts.attachments.length === 0) return reply.code(400).send({ error: "MESSAGE_REQUIRED" });

    const customerMessage = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        senderType: ChatSenderType.CUSTOMER,
        senderId: request.auth!.userId,
        content: parts.content,
        attachments: { create: parts.attachments }
      },
      include: { attachments: true }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
    emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message: customerMessage });

    if (conversation.status === ConversationStatus.ESCALATED) {
      await notifyAdmins({ type: "SUPPORT", title: "Nova mensagem no chat", message: parts.content ?? "Anexo recebido.", data: { conversationId: conversation.id } });
      return reply.code(201).send({ message: customerMessage });
    }

    if (!parts.content) {
      return reply.code(201).send({ message: customerMessage });
    }

    const history = await loadHistory(conversation.id);
    const { reply: botReply, escalate } = await handleCustomerMessage({ userId: request.auth!.userId, text: parts.content, history });
    const botMessage = await prisma.chatMessage.create({ data: { conversationId: conversation.id, senderType: ChatSenderType.BOT, content: botReply } });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), status: escalate ? ConversationStatus.ESCALATED : ConversationStatus.BOT }
    });
    emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message: botMessage });
    if (escalate) {
      await notifyAdmins({ type: "SUPPORT", title: "Conversa escalada", message: `Cliente precisa de apoio humano na conversa ${conversation.id}.`, data: { conversationId: conversation.id } });
      await audit({ actorId: request.auth!.userId, action: "CHAT_ESCALATED", entity: "Conversation", entityId: conversation.id });
    }
    return reply.code(201).send({ message: customerMessage, botMessage });
  });

  // --- Admin ---
  app.get("/admin/chat/conversations", { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] }, async (request) => {
    const q = z.object({ status: z.nativeEnum(ConversationStatus).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = q.status ? { status: q.status } : {};
    const [data, total] = await prisma.$transaction([
      prisma.conversation.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { lastMessageAt: "desc" }, include: { user: { select: { id: true, name: true, email: true, phone: true } } } }),
      prisma.conversation.count({ where })
    ]);
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.post("/admin/chat/conversations/:id/reply", { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });

    let parts: Awaited<ReturnType<typeof collectMessageParts>>;
    try {
      parts = await collectMessageParts(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "ATTACHMENT_UPLOAD_FAILED";
      return reply.code(message === "UNSUPPORTED_FILE_TYPE" ? 415 : message === "FILE_TOO_LARGE" ? 413 : 502).send({ error: message });
    }
    if (!parts.content && parts.attachments.length === 0) return reply.code(400).send({ error: "MESSAGE_REQUIRED" });

    const message = await prisma.chatMessage.create({
      data: { conversationId: conversation.id, senderType: ChatSenderType.ADMIN, senderId: request.auth!.userId, content: parts.content, attachments: { create: parts.attachments } },
      include: { attachments: true }
    });
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), status: ConversationStatus.ESCALATED, assignedAdminId: conversation.assignedAdminId ?? request.auth!.userId } });
    emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message });
    await notifyUser({ userId: conversation.userId, type: "SUPPORT", title: "Nova resposta do suporte", message: parts.content ?? "Recebeu um anexo.", data: { conversationId: conversation.id } });
    return reply.code(201).send({ message });
  });

  app.post("/admin/chat/conversations/:id/close", { preHandler: [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)] }, async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const conversation = await prisma.conversation.update({ where: { id: params.data.id }, data: { status: ConversationStatus.CLOSED } }).catch(() => null);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
    emitChatEvent(conversation.userId, "chat.closed", { conversationId: conversation.id });
    await audit({ actorId: request.auth!.userId, action: "CHAT_CLOSED", entity: "Conversation", entityId: conversation.id });
    return conversation;
  });
}
