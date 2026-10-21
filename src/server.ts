import { Server as SocketIOServer } from "socket.io";
import { buildApp } from "./app.js";
import { corsOrigins, env } from "./config/env.js";
import { verifyAccessToken } from "./lib/auth.js";
import { permissionsFor, type Permission } from "./lib/permissions.js";
import { setRealtimeServer } from "./services/realtime.js";
import { expireStaleOrders } from "./services/orderExpiry.js";
import { prisma } from "./lib/prisma.js";

const app = buildApp();
const io = new SocketIOServer(app.server, { cors: { origin: corsOrigins, credentials: true } });
setRealtimeServer(io);

io.use((socket, next) => {
  const token = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : undefined;
  if (!token) return next(new Error("UNAUTHORIZED"));
  try {
    const payload = verifyAccessToken(token);
    socket.data.userId = payload.sub;
    socket.data.roles = payload.roles;
    next();
  } catch {
    next(new Error("INVALID_TOKEN"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.data.userId as string;
  socket.join(`user:${userId}`);
  // Salas de administração pelo que a base de dados diz AGORA (não pelos papéis que vieram no token): o chat só vai a quem
  // tem suporte, a atividade geral a qualquer administrador com alguma permissão.
  let permissions: Permission[] = [];
  void prisma.user
    .findUnique({ where: { id: userId }, select: { status: true, adminProfiles: true, roles: { select: { role: { select: { name: true } } } } } })
    .then((user) => {
      if (!user || user.status === "BLOCKED" || user.status === "SUSPENDED") return;
      permissions = permissionsFor(user.roles.map((item) => item.role.name), user.adminProfiles);
      if (permissions.length > 0) socket.join("admins");
      if (permissions.includes("support.manage")) socket.join("admins:support");
    })
    .catch(() => undefined);
  socket.on("chat.typing", async (payload: { conversationId?: unknown; isTyping?: unknown }) => {
    if (typeof payload?.conversationId !== "string" || typeof payload?.isTyping !== "boolean") return;
    try {
      const conversation = await prisma.conversation.findUnique({ where: { id: payload.conversationId }, select: { id: true, userId: true } });
      if (!conversation) return;
      if (permissions.includes("support.manage")) io.to(`user:${conversation.userId}`).emit("chat.typing", { conversationId: conversation.id, isTyping: payload.isTyping, senderType: "ADMIN" });
      else if (conversation.userId === userId) io.to("admins:support").emit("chat.typing", { conversationId: conversation.id, isTyping: payload.isTyping, senderType: "CUSTOMER" });
    } catch { /* typing é informativo; não deve afectar a ligação */ }
  });
});

// Fecha as encomendas que não foram pagas a tempo e devolve o stock. Em serverless não há processo vivo:
// aí a expiração acontece ao ler (GET /orders, GET /orders/:id), que também chama expireStaleOrders.
const expiryTimer = setInterval(() => {
  expireStaleOrders().catch((error) => app.log.error(error, "order expiry sweep failed"));
}, 60_000);
expiryTimer.unref();

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
