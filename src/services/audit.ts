import { prisma } from "../lib/prisma.js";

export async function audit(input: {
  actorId?: string;
  action: string;
  entity: string;
  entityId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: unknown;
}): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      ip: input.ip,
      userAgent: input.userAgent,
      metadata: input.metadata === undefined ? undefined : (input.metadata as object)
    }
  });
}
