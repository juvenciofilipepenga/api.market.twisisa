import { OrderStatus, UserStatus } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";
import { notifyUser } from "./notifications.js";

// Uma indicação conta como "concluída" quando o convidado tem pelo menos uma encomenda paga e
// não cancelada/reembolsada. É calculado na hora (não há contador para dessincronizar):
// se a encomenda for cancelada ou reembolsada, a indicação deixa de contar sozinha.
export const QUALIFYING_ORDER_STATES: OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.READY_FOR_SHIPMENT,
  OrderStatus.SHIPPED,
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.DELIVERED
];

// Os códigos são cuid (alfanuméricos). Qualquer outra coisa é rejeitada antes de tocar na base de dados.
export function normalizeReferralCode(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length < 6 || value.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

export function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  return trimmed.split(/\s+/)[0] || trimmed;
}

// Só contas ativas podem convidar.
export function findActiveInviterByCode(code: string) {
  return prisma.user.findFirst({
    where: { referralCode: code, status: UserStatus.ACTIVE },
    select: { id: true, name: true }
  });
}

export async function referralStats(userId: string) {
  const [invited, completed] = await Promise.all([
    prisma.user.count({ where: { referredById: userId } }),
    prisma.user.count({ where: { referredById: userId, orders: { some: { status: { in: QUALIFYING_ORDER_STATES } } } } })
  ]);
  return { invited, completed, pending: Math.max(0, invited - completed) };
}

export async function notifyReferralSignup(inviterId: string, inviteeName: string): Promise<void> {
  await notifyUser({
    userId: inviterId,
    type: "REFERRAL",
    title: "Novo convidado",
    message: `${firstName(inviteeName)} criou conta com o seu convite.`
  });
}

// Chamar logo depois de uma encomenda passar a PAID. Só avisa na PRIMEIRA compra qualificada do convidado
// (se já havia outra encomenda paga, a indicação já tinha sido contada e avisada).
export async function notifyReferralCompletedIfFirst(buyerId: string, orderId: string): Promise<boolean> {
  const buyer = await prisma.user.findUnique({ where: { id: buyerId }, select: { name: true, referredById: true } });
  if (!buyer?.referredById) return false;
  const qualifying = await prisma.order.count({ where: { userId: buyerId, status: { in: QUALIFYING_ORDER_STATES } } });
  if (qualifying !== 1) return false;
  await notifyUser({
    userId: buyer.referredById,
    type: "REFERRAL",
    title: "Convite concluído",
    message: `${firstName(buyer.name)} fez a primeira compra com o seu convite.`,
    data: { orderId }
  });
  return true;
}
