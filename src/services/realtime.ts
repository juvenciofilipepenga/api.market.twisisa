import type { Server } from "socket.io";

let io: Server | null = null;

export function setRealtimeServer(server: Server): void { io = server; }
export function emitRealtime(event: string, payload: unknown): void { io?.emit(event, payload); }
export function emitToUser(userId: string, event: string, payload: unknown): void { io?.to(`user:${userId}`).emit(event, payload); }
export function emitToAdmins(event: string, payload: unknown): void { io?.to("admins").emit(event, payload); }
// O chat leva o texto das mensagens: só a equipa de suporte o recebe (não todos os administradores).
export function emitChatEvent(userId: string, event: string, payload: unknown): void {
  io?.to(`user:${userId}`).emit(event, payload);
  io?.to("admins:support").emit(event, payload);
}
