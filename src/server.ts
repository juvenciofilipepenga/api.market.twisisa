import { Server as SocketIOServer } from "socket.io";
import { RoleName } from "./generated/prisma/client.js";
import { buildApp } from "./app.js";
import { corsOrigins, env } from "./config/env.js";
import { verifyAccessToken } from "./lib/auth.js";
import { isAdmin } from "./middleware/auth.js";
import { setRealtimeServer } from "./services/realtime.js";

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
  const roles = socket.data.roles as string[];
  socket.join(`user:${userId}`);
  if (isAdmin(roles.filter((role): role is RoleName => Object.values(RoleName).includes(role as RoleName)))) socket.join("admins");
});

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
