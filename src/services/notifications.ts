import { NotificationType, RoleName } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { emitRealtime, emitToAdmins, emitToUser } from "./realtime.js";

export async function notifyUser(input: {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: unknown;
}) {
  const notification = await prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      message: input.message,
      data: input.data === undefined ? undefined : (input.data as object)
    }
  });
  emitToUser(input.userId, "notification.created", notification);
  emitRealtime("dashboard.activity", { type: input.type, notificationId: notification.id, createdAt: notification.createdAt });
  return notification;
}

export async function notifyAdmins(input: {
  type: NotificationType;
  title: string;
  message: string;
  data?: unknown;
}) {
  const admins = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      roles: { some: { role: { name: { in: [RoleName.ADMIN, RoleName.SUPER_ADMIN] } } } }
    },
    select: { id: true }
  });
  const notifications = await Promise.all(
    admins.map((admin) => notifyUser({ userId: admin.id, ...input }))
  );
  emitToAdmins("admin.alert", input);
  return notifications;
}
