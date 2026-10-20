import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ChatSenderType, ConversationStatus, RoleName, type Prisma } from "../generated/prisma/client.js";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { detectMime, isFileTooLarge } from "../lib/files.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { uploadChatAttachment } from "../services/cloudinary.js";
import { generateAiReply, greetingMessage, loadAiSettings } from "../services/chatBot.js";
import { emitChatEvent } from "../services/realtime.js";
import { notifyAdmins, notifyUser } from "../services/notifications.js";

const ALLOWED_ATTACHMENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const HISTORY_LIMIT = 12;
const MAX_CONTENT_CHARS = 4000;
// "A escrever" some sozinho se o outro lado deixar de enviar sinal (fechou o separador, perdeu rede).
const TYPING_TTL_MS = 6_000;
// Online = houve um pedido do chat nos últimos 60 s (cada pedido de sincronização conta como batimento).
const ONLINE_TTL_MS = 60_000;
// A sincronização repete uma janela curta para não perder mensagens por diferenças de relógio entre instâncias.
const SYNC_OVERLAP_MS = 2_000;
const SYNC_MAX_MESSAGES = 200;
const ADMIN_ROLES: RoleName[] = [RoleName.ADMIN, RoleName.SUPER_ADMIN];
const adminGuard = [requireAuth, requireRole(RoleName.ADMIN, RoleName.SUPER_ADMIN)];
const ATTACHMENT_ONLY_REPLY = "Recebi o seu anexo. Vou encaminhar para um atendente que o possa ver.";

type Viewer = "CUSTOMER" | "ADMIN";
type PendingAttachment = { url: string; publicId?: string; mimeType: string; sizeBytes: number };
type MessageParts = { content: string | undefined; clientId: string | undefined; attachments: PendingAttachment[] };

const idParams = z.object({ id: z.string().min(1) });
const clientIdSchema = z.string().trim().min(8).max(64);

// Erros de upload conhecidos; qualquer outro (ex.: mensagem interna do Cloudinary) vira um código genérico.
function uploadFailure(error: unknown): { status: number; code: string } {
  const message = error instanceof Error ? error.message : "";
  if (message === "UNSUPPORTED_FILE_TYPE") return { status: 415, code: message };
  if (message === "FILE_TOO_LARGE") return { status: 413, code: message };
  if (message === "CLOUDINARY_NOT_CONFIGURED") return { status: 503, code: message };
  return { status: 502, code: "ATTACHMENT_UPLOAD_FAILED" };
}

async function collectMessageParts(request: FastifyRequest): Promise<MessageParts> {
  if (!request.isMultipart()) {
    const parsed = z.object({ content: z.string().trim().min(1).max(MAX_CONTENT_CHARS).optional(), clientId: clientIdSchema.optional() }).safeParse(request.body);
    return { content: parsed.success ? parsed.data.content : undefined, clientId: parsed.success ? parsed.data.clientId : undefined, attachments: [] };
  }
  let content: string | undefined;
  let clientId: string | undefined;
  const attachments: PendingAttachment[] = [];
  for await (const part of request.parts()) {
    if (part.type === "field" && part.fieldname === "content" && typeof part.value === "string") {
      content = part.value.trim().slice(0, MAX_CONTENT_CHARS) || undefined;
    } else if (part.type === "field" && part.fieldname === "clientId" && typeof part.value === "string") {
      const parsed = clientIdSchema.safeParse(part.value);
      if (parsed.success) clientId = parsed.data;
    } else if (part.type === "file") {
      if (!ALLOWED_ATTACHMENT_TYPES.has(part.mimetype)) {
        part.file.resume();
        throw new Error("UNSUPPORTED_FILE_TYPE");
      }
      let buffer: Buffer;
      try {
        buffer = await part.toBuffer();
      } catch (error) {
        if (isFileTooLarge(error)) throw new Error("FILE_TOO_LARGE");
        throw error;
      }
      if (buffer.length === 0) continue;
      if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error("FILE_TOO_LARGE");
      // O tipo vem do conteúdo (o mimetype declarado pelo cliente não é de confiança).
      const detected = detectMime(buffer);
      if (!detected || !ALLOWED_ATTACHMENT_TYPES.has(detected)) throw new Error("UNSUPPORTED_FILE_TYPE");
      const result = await uploadChatAttachment(buffer, detected);
      attachments.push({
        url: String(result.secure_url ?? result.url),
        publicId: typeof result.public_id === "string" ? result.public_id : undefined,
        mimeType: detected,
        sizeBytes: buffer.length
      });
    }
  }
  return { content, clientId, attachments };
}

function previewOf(content: string | null | undefined, hasAttachments: boolean): string {
  const text = (content ?? "").replace(/\s+/g, " ").trim();
  return (text || (hasAttachments ? "[Anexo]" : "")).slice(0, 140);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002";
}

// Batimento de presença. SQL directo para não mexer em User.updatedAt, e no máximo uma escrita a cada 20 s por utilizador.
async function touchPresence(userId: string): Promise<void> {
  try {
    await prisma.$executeRaw`UPDATE "User" SET "lastSeenAt" = NOW() WHERE "id" = ${userId} AND ("lastSeenAt" IS NULL OR "lastSeenAt" < NOW() - INTERVAL '20 seconds')`;
  } catch {
    // A presença é informativa: nunca deve falhar um pedido.
  }
}

function isFresh(date: Date | null | undefined, ttlMs: number): boolean {
  return Boolean(date && Date.now() - date.getTime() < ttlMs);
}

async function touchConversation(
  conversationId: string,
  message: { content: string | null; senderType: ChatSenderType; attachments?: unknown[] },
  extra: Prisma.ConversationUpdateInput = {}
): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastMessageAt: new Date(),
      lastMessagePreview: previewOf(message.content, Boolean(message.attachments?.length)),
      lastMessageSender: message.senderType,
      ...extra
    }
  });
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

async function markRead(conversationId: string, reader: Viewer): Promise<number> {
  // Quem lê marca como vistas as mensagens do outro lado. O cliente também "vê" as do bot; o admin vê as do cliente.
  const senderTypes = reader === "CUSTOMER" ? [ChatSenderType.BOT, ChatSenderType.ADMIN] : [ChatSenderType.CUSTOMER];
  const result = await prisma.chatMessage.updateMany({
    where: { conversationId, senderType: { in: senderTypes }, readAt: null },
    data: { readAt: new Date() }
  });
  return result.count;
}

async function setTyping(conversation: { id: string; userId: string }, side: Viewer, isTyping: boolean): Promise<void> {
  const at = isTyping ? new Date() : null;
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: side === "CUSTOMER" ? { customerTypingAt: at } : { adminTypingAt: at }
  });
  emitChatEvent(conversation.userId, "chat.typing", { conversationId: conversation.id, isTyping, senderType: side });
}

// Tudo o que o ecrã precisa num só pedido: mensagens novas ou vistas desde `since`, "a escrever" e presença do outro lado.
// Funciona com ou sem Socket.IO (em Vercel não há WebSocket), por isso o cliente usa isto como base e o socket só o acelera.
async function buildSync(
  conversation: { id: string; userId: string; status: ConversationStatus; lastMessageAt: Date; customerTypingAt: Date | null; adminTypingAt: Date | null },
  viewer: Viewer,
  sinceRaw: string | undefined
) {
  const now = new Date();
  const parsed = sinceRaw ? new Date(sinceRaw) : null;
  const since = parsed && !Number.isNaN(parsed.getTime()) ? new Date(parsed.getTime() - SYNC_OVERLAP_MS) : null;
  const messages = since
    ? await prisma.chatMessage.findMany({
        where: { conversationId: conversation.id, OR: [{ createdAt: { gt: since } }, { readAt: { gt: since } }] },
        orderBy: { createdAt: "asc" },
        take: SYNC_MAX_MESSAGES,
        include: { attachments: true }
      })
    : (await prisma.chatMessage.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "desc" },
        take: SYNC_MAX_MESSAGES,
        include: { attachments: true }
      })).reverse();

  let peerOnline: boolean;
  if (viewer === "CUSTOMER") {
    // Com a IA ligada o atendimento está sempre online; sem ela, só se houver um admin com o painel aberto.
    const settings = await loadAiSettings();
    if (settings.enabled) peerOnline = true;
    else {
      const adminsOnline = await prisma.user.count({
        where: { lastSeenAt: { gt: new Date(Date.now() - ONLINE_TTL_MS) }, roles: { some: { role: { name: { in: ADMIN_ROLES } } } } }
      });
      peerOnline = adminsOnline > 0;
    }
  } else {
    const customer = await prisma.user.findUnique({ where: { id: conversation.userId }, select: { lastSeenAt: true } });
    peerOnline = isFresh(customer?.lastSeenAt, ONLINE_TTL_MS);
  }
  const typing = isFresh(viewer === "CUSTOMER" ? conversation.adminTypingAt : conversation.customerTypingAt, TYPING_TTL_MS);
  return {
    serverTime: now.toISOString(),
    conversation: { id: conversation.id, status: conversation.status, lastMessageAt: conversation.lastMessageAt },
    messages,
    typing,
    peerOnline
  };
}

async function ownedConversation(request: FastifyRequest, reply: FastifyReply) {
  const params = idParams.safeParse(request.params);
  if (!params.success) { reply.code(400).send({ error: "INVALID_INPUT" }); return null; }
  const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
  if (!conversation) { reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" }); return null; }
  if (conversation.userId !== request.auth!.userId) { reply.code(403).send({ error: "FORBIDDEN" }); return null; }
  return conversation;
}

async function anyConversation(request: FastifyRequest, reply: FastifyReply) {
  const params = idParams.safeParse(request.params);
  if (!params.success) { reply.code(400).send({ error: "INVALID_INPUT" }); return null; }
  const conversation = await prisma.conversation.findUnique({ where: { id: params.data.id } });
  if (!conversation) { reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" }); return null; }
  return conversation;
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // Devolve a conversa em curso do cliente (cria uma nova com a saudação, se não existir nenhuma aberta).
  app.post("/chat/conversations", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    void touchPresence(userId);
    const settings = await loadAiSettings();
    let conversation = await prisma.conversation.findFirst({
      where: { userId, status: { in: [ConversationStatus.BOT, ConversationStatus.ESCALATED] } },
      orderBy: { lastMessageAt: "desc" }
    });
    if (!conversation) {
      const greeting = greetingMessage(settings);
      conversation = await prisma.conversation.create({
        data: {
          userId,
          lastMessagePreview: previewOf(greeting, false),
          lastMessageSender: ChatSenderType.BOT,
          messages: { create: { senderType: ChatSenderType.BOT, content: greeting } }
        }
      });
    }
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, include: { attachments: true } });
    return { conversation, messages, assistantName: settings.assistantName, aiEnabled: settings.enabled };
  });

  app.get("/chat/conversations", { preHandler: requireAuth }, async (request) => {
    const conversations = await prisma.conversation.findMany({ where: { userId: request.auth!.userId }, orderBy: { lastMessageAt: "desc" }, take: 20 });
    return { data: conversations };
  });

  app.get("/chat/conversations/:id/messages", { preHandler: requireAuth }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    const roles = request.auth!.roles;
    const admin = roles.some((role) => ADMIN_ROLES.includes(role));
    if (conversation.userId !== request.auth!.userId && !admin) return reply.code(403).send({ error: "FORBIDDEN" });
    const messages = await prisma.chatMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, include: { attachments: true } });
    return { conversation, messages };
  });

  app.get("/chat/conversations/:id/sync", { preHandler: requireAuth, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await ownedConversation(request, reply);
    if (!conversation) return reply;
    void touchPresence(request.auth!.userId);
    const query = z.object({ since: z.string().max(40).optional() }).safeParse(request.query);
    return buildSync(conversation, "CUSTOMER", query.success ? query.data.since : undefined);
  });

  // Cliente envia mensagem (texto e/ou anexo). Só guarda e responde já: a resposta da IA vem num pedido à parte (ai-reply),
  // para o cliente ver "enviado" de imediato em vez de esperar pelo Groq.
  app.post("/chat/conversations/:id/messages", { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await ownedConversation(request, reply);
    if (!conversation) return reply;
    if (conversation.status === ConversationStatus.CLOSED) return reply.code(409).send({ error: "CONVERSATION_CLOSED" });

    let parts: MessageParts;
    try {
      parts = await collectMessageParts(request);
    } catch (error) {
      request.log.warn(error, "chat attachment rejected");
      const failure = uploadFailure(error);
      return reply.code(failure.status).send({ error: failure.code });
    }
    if (!parts.content && parts.attachments.length === 0) return reply.code(400).send({ error: "MESSAGE_REQUIRED" });

    const findByClientId = () => parts.clientId
      ? prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: conversation.id, clientId: parts.clientId } }, include: { attachments: true } })
      : Promise.resolve(null);
    // Reenvio (ex.: a resposta anterior perdeu-se na rede): devolve a mensagem já gravada, não cria outra.
    const existing = await findByClientId();
    if (existing) return reply.code(200).send({ message: existing, aiPending: false });

    let customerMessage;
    try {
      customerMessage = await prisma.chatMessage.create({
        data: {
          conversationId: conversation.id,
          senderType: ChatSenderType.CUSTOMER,
          senderId: request.auth!.userId,
          content: parts.content,
          clientId: parts.clientId,
          attachments: { create: parts.attachments }
        },
        include: { attachments: true }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findByClientId();
      if (raced) return reply.code(200).send({ message: raced, aiPending: false });
      throw error;
    }
    await touchConversation(conversation.id, customerMessage, { customerTypingAt: null });
    emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message: customerMessage });

    if (conversation.status === ConversationStatus.ESCALATED) {
      await notifyAdmins({ type: "SUPPORT", title: "Nova mensagem no chat", message: parts.content ?? "Anexo recebido.", data: { conversationId: conversation.id } });
      return reply.code(201).send({ message: customerMessage, aiPending: false });
    }
    return reply.code(201).send({ message: customerMessage, aiPending: true });
  });

  // Resposta automática à última mensagem do cliente. Idempotente (clientId "ai:<id da mensagem>") e só responde se essa
  // mensagem ainda for a última: várias mensagens seguidas recebem uma única resposta, à última.
  app.post("/chat/conversations/:id/ai-reply", { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await ownedConversation(request, reply);
    if (!conversation) return reply;
    const body = z.object({ afterMessageId: z.string().min(1) }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    if (conversation.status !== ConversationStatus.BOT) return reply.send({ botMessage: null, escalated: conversation.status === ConversationStatus.ESCALATED });

    const latest = await prisma.chatMessage.findFirst({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" } });
    if (!latest || latest.id !== body.data.afterMessageId || latest.senderType !== ChatSenderType.CUSTOMER) return reply.send({ botMessage: null, escalated: false });

    const settings = await loadAiSettings();
    const result = latest.content
      ? await generateAiReply({ userId: conversation.userId, text: latest.content, history: await loadHistory(conversation.id), settings })
      : { reply: settings.enabled ? ATTACHMENT_ONLY_REPLY : null, escalate: true, usedKnowledge: [] as string[] };

    // Durante a chamada ao Groq um admin pode ter respondido (conversa passou a ESCALATED): a IA cala-se.
    const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { status: true } });
    if (!fresh || fresh.status !== ConversationStatus.BOT) return reply.send({ botMessage: null, escalated: true });

    let botMessage = null;
    if (result.reply) {
      try {
        botMessage = await prisma.chatMessage.create({
          data: { conversationId: conversation.id, senderType: ChatSenderType.BOT, content: result.reply, clientId: `ai:${latest.id}` },
          include: { attachments: true }
        });
        await touchConversation(conversation.id, botMessage);
        emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message: botMessage });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        botMessage = await prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: conversation.id, clientId: `ai:${latest.id}` } }, include: { attachments: true } });
        return reply.send({ botMessage, escalated: false });
      }
    }
    if (result.escalate) {
      // Condicional a BOT: se um admin assumiu entretanto, não se repõe nada.
      await prisma.conversation.updateMany({ where: { id: conversation.id, status: ConversationStatus.BOT }, data: { status: ConversationStatus.ESCALATED } });
      await notifyAdmins({ type: "SUPPORT", title: "Conversa à espera de um humano", message: latest.content ?? "Anexo recebido.", data: { conversationId: conversation.id } });
      await audit({ actorId: request.auth!.userId, action: "CHAT_ESCALATED", entity: "Conversation", entityId: conversation.id });
      emitChatEvent(conversation.userId, "chat.status", { conversationId: conversation.id, status: ConversationStatus.ESCALATED });
    }
    return reply.send({ botMessage, escalated: result.escalate });
  });

  app.post("/chat/conversations/:id/typing", { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await ownedConversation(request, reply);
    if (!conversation) return reply;
    const body = z.object({ isTyping: z.boolean() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    await setTyping(conversation, "CUSTOMER", body.data.isTyping);
    return reply.code(204).send();
  });

  app.post("/chat/conversations/:id/read", { preHandler: requireAuth, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await ownedConversation(request, reply);
    if (!conversation) return reply;
    const count = await markRead(conversation.id, "CUSTOMER");
    if (count > 0) emitChatEvent(conversation.userId, "chat.read", { conversationId: conversation.id, by: "CUSTOMER" });
    return { updated: count };
  });

  // --- Admin ---
  app.get("/admin/chat/conversations", { preHandler: adminGuard, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request) => {
    void touchPresence(request.auth!.userId);
    const q = z.object({ status: z.nativeEnum(ConversationStatus).optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const where = q.status ? { status: q.status } : {};
    const [rows, total] = await Promise.all([
      prisma.conversation.findMany({ where, skip: (q.page - 1) * q.limit, take: q.limit, orderBy: { lastMessageAt: "desc" }, include: { user: { select: { id: true, name: true, email: true, phone: true, lastSeenAt: true } } } }),
      prisma.conversation.count({ where })
    ]);
    const ids = rows.map((row) => row.id);
    const unread = ids.length > 0
      ? await prisma.chatMessage.groupBy({ by: ["conversationId"], where: { conversationId: { in: ids }, senderType: ChatSenderType.CUSTOMER, readAt: null }, _count: { _all: true } })
      : [];
    const unreadById = new Map(unread.map((item) => [item.conversationId, item._count._all]));
    const data = rows.map(({ user, ...conversation }) => ({
      ...conversation,
      user: { id: user.id, name: user.name, email: user.email, phone: user.phone },
      unreadCount: unreadById.get(conversation.id) ?? 0,
      customerOnline: isFresh(user.lastSeenAt, ONLINE_TTL_MS)
    }));
    return { data, pagination: { page: q.page, limit: q.limit, total } };
  });

  app.get("/admin/chat/conversations/:id/sync", { preHandler: adminGuard, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    void touchPresence(request.auth!.userId);
    const query = z.object({ since: z.string().max(40).optional() }).safeParse(request.query);
    return buildSync(conversation, "ADMIN", query.success ? query.data.since : undefined);
  });

  app.post("/admin/chat/conversations/:id/reply", { preHandler: adminGuard, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    // Antes a resposta de um admin reabria em silêncio uma conversa fechada (status passava a ESCALATED).
    if (conversation.status === ConversationStatus.CLOSED) return reply.code(409).send({ error: "CONVERSATION_CLOSED" });

    let parts: MessageParts;
    try {
      parts = await collectMessageParts(request);
    } catch (error) {
      request.log.warn(error, "chat attachment rejected");
      const failure = uploadFailure(error);
      return reply.code(failure.status).send({ error: failure.code });
    }
    if (!parts.content && parts.attachments.length === 0) return reply.code(400).send({ error: "MESSAGE_REQUIRED" });

    const findByClientId = () => parts.clientId
      ? prisma.chatMessage.findUnique({ where: { conversationId_clientId: { conversationId: conversation.id, clientId: parts.clientId } }, include: { attachments: true } })
      : Promise.resolve(null);
    const existing = await findByClientId();
    if (existing) return reply.code(200).send({ message: existing });

    let message;
    try {
      message = await prisma.chatMessage.create({
        data: { conversationId: conversation.id, senderType: ChatSenderType.ADMIN, senderId: request.auth!.userId, content: parts.content, clientId: parts.clientId, attachments: { create: parts.attachments } },
        include: { attachments: true }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await findByClientId();
      if (raced) return reply.code(200).send({ message: raced });
      throw error;
    }
    await touchConversation(conversation.id, message, {
      status: ConversationStatus.ESCALATED,
      adminTypingAt: null,
      ...(conversation.assignedAdminId ? {} : { assignedAdminId: request.auth!.userId })
    });
    // Quem responde viu o que o cliente escreveu.
    await markRead(conversation.id, "ADMIN");
    emitChatEvent(conversation.userId, "chat.message", { conversationId: conversation.id, message });
    await notifyUser({ userId: conversation.userId, type: "SUPPORT", title: "Nova resposta do suporte", message: parts.content ?? "Recebeu um anexo.", data: { conversationId: conversation.id } });
    return reply.code(201).send({ message });
  });

  app.post("/admin/chat/conversations/:id/typing", { preHandler: adminGuard, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    const body = z.object({ isTyping: z.boolean() }).safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    await setTyping(conversation, "ADMIN", body.data.isTyping);
    return reply.code(204).send();
  });

  app.post("/admin/chat/conversations/:id/read", { preHandler: adminGuard, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    const count = await markRead(conversation.id, "ADMIN");
    if (count > 0) emitChatEvent(conversation.userId, "chat.read", { conversationId: conversation.id, by: "ADMIN" });
    return { updated: count };
  });

  // Devolve a conversa à IA (depois de um humano a ter assumido).
  app.post("/admin/chat/conversations/:id/ai-resume", { preHandler: adminGuard }, async (request, reply) => {
    const conversation = await anyConversation(request, reply);
    if (!conversation) return reply;
    const result = await prisma.conversation.updateMany({ where: { id: conversation.id, status: ConversationStatus.ESCALATED }, data: { status: ConversationStatus.BOT, assignedAdminId: null } });
    if (result.count === 0) return reply.code(409).send({ error: "NOT_ESCALATED" });
    await audit({ actorId: request.auth!.userId, action: "CHAT_AI_RESUMED", entity: "Conversation", entityId: conversation.id });
    emitChatEvent(conversation.userId, "chat.status", { conversationId: conversation.id, status: ConversationStatus.BOT });
    return { id: conversation.id, status: ConversationStatus.BOT };
  });

  app.post("/admin/chat/conversations/:id/close", { preHandler: adminGuard }, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "INVALID_INPUT" });
    const conversation = await prisma.conversation.update({ where: { id: params.data.id }, data: { status: ConversationStatus.CLOSED } }).catch(() => null);
    if (!conversation) return reply.code(404).send({ error: "CONVERSATION_NOT_FOUND" });
    emitChatEvent(conversation.userId, "chat.closed", { conversationId: conversation.id });
    await audit({ actorId: request.auth!.userId, action: "CHAT_CLOSED", entity: "Conversation", entityId: conversation.id });
    return conversation;
  });
}
