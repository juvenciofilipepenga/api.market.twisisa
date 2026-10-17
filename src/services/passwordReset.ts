import type { FastifyBaseLogger } from "fastify";
import { NotificationType, RoleName, UserStatus } from "../generated/prisma/client.js";
import { emailjsConfig, env, frontendUrl } from "../config/env.js";
import { hashPassword, signAccessToken, verifyPassword } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";
import { buildResetLink, generateResetToken, hashResetToken, isWellFormedResetToken, maskEmail } from "../lib/resetToken.js";
import { audit } from "./audit.js";
import { sendEmailJs } from "./emailjs.js";
import { notifyUser } from "./notifications.js";

export const RESET_COOLDOWN_SECONDS = 60;   // entre dois pedidos para a mesma conta
const COOLDOWN_MS = RESET_COOLDOWN_SECONDS * 1000;
const MAX_PER_HOUR = 5;              // pedidos por conta e por hora (evita encher a caixa de alguém)
const MIN_RESPONSE_MS = 700;         // resposta com duração parecida exista a conta ou não (ver requestPasswordReset)
const CLEANUP_AFTER_MS = 24 * 3_600_000;

type Ctx = { ip?: string; userAgent?: string; log: FastifyBaseLogger };

async function holdUntil(startedAt: number, minMs: number): Promise<void> {
  if (env.NODE_ENV === "test") return;
  const left = minMs - (Date.now() - startedAt);
  if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
}

function isRestricted(status: UserStatus): boolean {
  return status === UserStatus.BLOCKED || status === UserStatus.SUSPENDED;
}

async function safeAudit(ctx: Ctx, input: Parameters<typeof audit>[0]): Promise<void> {
  try { await audit({ ip: ctx.ip, userAgent: ctx.userAgent, ...input }); } catch (error) { ctx.log.error(error, "audit failed"); }
}

/**
 * Pede o email de recuperação. Devolve sempre o mesmo resultado exista a conta ou não (não revela que emails estão
 * registados): "UNAVAILABLE" só acontece quando o envio de email não está configurado em produção, o que não depende da conta.
 * Em serverless o envio tem de acontecer ANTES de responder (o processo pode ser congelado depois), por isso aguarda-se
 * o EmailJS e a resposta é alongada até MIN_RESPONSE_MS para não denunciar, pelo tempo, quais contas existem.
 */
export async function requestPasswordReset(email: string, ctx: Ctx): Promise<"OK" | "UNAVAILABLE"> {
  if (!emailjsConfig && env.NODE_ENV === "production") {
    ctx.log.error("password reset requested but EMAILJS_* variables are not configured");
    return "UNAVAILABLE";
  }
  const startedAt = Date.now();
  try {
    await issueResetEmail(email, ctx);
  } finally {
    await holdUntil(startedAt, MIN_RESPONSE_MS);
  }
  return "OK";
}

async function issueResetEmail(email: string, ctx: Ctx): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, name: true, email: true, status: true } });
  if (!user || isRestricted(user.status)) return;

  const now = new Date();
  const recent = await prisma.passwordReset.findMany({
    where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
    take: MAX_PER_HOUR
  });
  if (recent.length >= MAX_PER_HOUR) return;
  if (recent[0] && now.getTime() - recent[0].createdAt.getTime() < COOLDOWN_MS) return;

  const token = generateResetToken();
  const expiresAt = new Date(now.getTime() + env.PASSWORD_RESET_TTL_MINUTES * 60_000);
  // Só o link mais recente funciona: os anteriores ficam marcados como usados.
  const created = await prisma.$transaction(async (tx) => {
    await tx.passwordReset.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
    return tx.passwordReset.create({ data: { userId: user.id, tokenHash: hashResetToken(token), expiresAt, requestIp: ctx.ip }, select: { id: true } });
  });
  await safeAudit(ctx, { actorId: user.id, action: "PASSWORD_RESET_REQUESTED", entity: "User", entityId: user.id });

  const link = buildResetLink(frontendUrl, token);
  if (!emailjsConfig) {
    // Só em desenvolvimento/testes: sem EmailJS o link aparece no log do servidor para se poder testar o fluxo.
    if (env.NODE_ENV === "development") ctx.log.info({ link }, "EMAILJS_* not set: reset link (development only)");
    return;
  }
  const result = await sendEmailJs(emailjsConfig.templateReset, {
    to_email: user.email,
    to_name: user.name,
    reset_link: link,
    expires_minutes: env.PASSWORD_RESET_TTL_MINUTES,
    site_name: "Twisisa Market"
  });
  if (!result.ok) {
    ctx.log.error({ reason: result.reason, status: result.status, detail: result.detail }, "password reset email failed");
    await prisma.passwordReset.update({ where: { id: created.id }, data: { usedAt: new Date() } }).catch(() => undefined);
    await safeAudit(ctx, { actorId: user.id, action: "PASSWORD_RESET_EMAIL_FAILED", entity: "User", entityId: user.id, metadata: { reason: result.reason, status: result.status } });
  }
  // Limpeza oportunista de registos antigos (não há tarefa agendada em serverless).
  await prisma.passwordReset.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) } } }).catch(() => undefined);
}

export type TokenCheck =
  | { state: "valid"; emailMasked: string; expiresAt: Date }
  | { state: "invalid" | "expired" | "used" | "restricted" };

/** A página de redefinição pergunta isto ao abrir, para avisar logo de um link expirado (em vez de só no fim do formulário). */
export async function checkResetToken(token: unknown): Promise<TokenCheck> {
  if (!isWellFormedResetToken(token)) return { state: "invalid" };
  const row = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: { usedAt: true, expiresAt: true, user: { select: { email: true, status: true } } }
  });
  if (!row) return { state: "invalid" };
  if (row.usedAt) return { state: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { state: "expired" };
  if (isRestricted(row.user.status)) return { state: "restricted" };
  return { state: "valid", emailMasked: maskEmail(row.user.email), expiresAt: row.expiresAt };
}

export type ResetResult =
  | { state: "done"; user: { id: string; name: string; email: string; roles: string[] }; accessToken: string | null }
  | { state: "invalid" | "expired" | "used" | "restricted" | "same_password" };

export async function completePasswordReset(token: unknown, newPassword: string, ctx: Ctx): Promise<ResetResult> {
  if (!isWellFormedResetToken(token)) return { state: "invalid" };
  const row = await prisma.passwordReset.findUnique({
    where: { tokenHash: hashResetToken(token) },
    select: {
      id: true, usedAt: true, expiresAt: true,
      user: { select: { id: true, name: true, email: true, status: true, passwordHash: true, roles: { select: { role: { select: { name: true } } } } } }
    }
  });
  if (!row) return { state: "invalid" };
  if (row.usedAt) return { state: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { state: "expired" };
  if (isRestricted(row.user.status)) return { state: "restricted" };
  if (await verifyPassword(newPassword, row.user.passwordHash)) return { state: "same_password" };

  const passwordHash = await hashPassword(newPassword);
  const now = new Date();
  const claimed = await prisma.$transaction(async (tx) => {
    // Reclamar o link é atómico: dois pedidos em simultâneo com o mesmo link, só um passa.
    const claim = await tx.passwordReset.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claim.count !== 1) return false;
    await tx.user.update({ where: { id: row.user.id }, data: { passwordHash, passwordChangedAt: now } });
    await tx.passwordReset.updateMany({ where: { userId: row.user.id, usedAt: null }, data: { usedAt: now } });
    return true;
  });
  if (!claimed) return { state: "used" };

  await safeAudit(ctx, { actorId: row.user.id, action: "PASSWORD_RESET_COMPLETED", entity: "User", entityId: row.user.id });
  await notifyPasswordChanged(row.user, now, ctx);

  const roles = row.user.roles.map((item) => item.role.name);
  const isStaff = roles.includes(RoleName.ADMIN) || roles.includes(RoleName.SUPER_ADMIN);
  // Cliente: entra logo (menos um passo). Contas de administração voltam a autenticar-se pelo login.
  return {
    state: "done",
    user: { id: row.user.id, name: row.user.name, email: row.user.email, roles },
    accessToken: isStaff ? null : signAccessToken(row.user.id, roles)
  };
}

// Aviso de segurança: se não foi a própria pessoa, fica a saber. Falhas aqui nunca desfazem a redefinição.
async function notifyPasswordChanged(user: { id: string; name: string; email: string }, when: Date, ctx: Ctx): Promise<void> {
  try {
    await notifyUser({ userId: user.id, type: NotificationType.SECURITY, title: "Palavra-passe alterada", message: "A palavra-passe da sua conta foi alterada. Se não foi você, contacte-nos pelo chat." });
  } catch (error) { ctx.log.error(error, "password changed notification failed"); }
  if (emailjsConfig?.templateChanged) {
    const result = await sendEmailJs(emailjsConfig.templateChanged, {
      to_email: user.email,
      to_name: user.name,
      changed_at: when.toLocaleString("pt-PT", { timeZone: "Africa/Maputo", dateStyle: "long", timeStyle: "short" }),
      site_url: frontendUrl,
      site_name: "Twisisa Market"
    });
    if (!result.ok) ctx.log.error({ reason: result.reason, status: result.status, detail: result.detail }, "password changed email failed");
  }
}
