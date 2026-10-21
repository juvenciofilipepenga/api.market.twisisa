import { NotificationType, RoleName, type AdminProfile } from "../generated/prisma/client.js";
import { profilesWith, type Permission } from "../lib/permissions.js";
import { prisma } from "../lib/prisma.js";
import { emitToAdmins, emitToUser } from "./realtime.js";

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
  // Só os admins veem a atividade global; emitir para todos expunha a clientes o tipo/ids das notificações de outros.
  emitToAdmins("dashboard.activity", { type: input.type, notificationId: notification.id, createdAt: notification.createdAt });
  return notification;
}

// A quem chega cada tipo, por omissão: pagamentos a quem gere pagamentos, encomendas a quem gere encomendas, suporte a quem
// atende. Os outros tipos (sistema, segurança…) vão a todos os administradores. `audience` troca o padrão num aviso concreto.
const DEFAULT_AUDIENCE: Partial<Record<NotificationType, Permission[]>> = {
  PAYMENT: ["payments.manage"],
  ORDER: ["orders.manage"],
  SUPPORT: ["support.manage"]
};

export async function notifyAdmins(input: {
  type: NotificationType;
  title: string;
  message: string;
  data?: unknown;
  audience?: Permission[];
}) {
  const { audience: explicit, ...content } = input;
  const audience = explicit ?? DEFAULT_AUDIENCE[input.type];
  const profiles = audience ? (profilesWith(audience) as AdminProfile[]) : null;
  const admins = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      OR: [
        { roles: { some: { role: { name: RoleName.SUPER_ADMIN } } } },
        { roles: { some: { role: { name: RoleName.ADMIN } } }, ...(profiles ? { adminProfiles: { hasSome: profiles } } : {}) }
      ]
    },
    select: { id: true }
  });
  const notifications = await Promise.all(
    admins.map((admin) => notifyUser({ userId: admin.id, ...content }))
  );
  // Só aos destinatários (antes ia a todos os admins, com título e dados, mesmo a quem não devia ver aquela área).
  for (const admin of admins) emitToUser(admin.id, "admin.alert", { type: input.type });
  return notifications;
}
