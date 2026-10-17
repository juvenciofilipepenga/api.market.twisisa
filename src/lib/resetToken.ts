import crypto from "node:crypto";

// Funções puras (sem base de dados nem rede) da recuperação de palavra-passe: fáceis de testar.

/** 32 bytes aleatórios em base64url: 43 caracteres, 256 bits de entropia. */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Rejeita à partida o que nunca poderia ser um token nosso (sem tocar na base de dados). */
export function isWellFormedResetToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/** Só o hash fica guardado: quem lê a base de dados não consegue usar um link pendente. */
export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function buildResetLink(frontendUrl: string, token: string): string {
  return `${frontendUrl.replace(/\/+$/, "")}/redefinir?token=${encodeURIComponent(token)}`;
}

/** "juvencio@gmail.com" -> "j*******@gmail.com" (mostrado ao cliente na página de redefinição). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}${"*".repeat(Math.min(Math.max(local.length - 1, 2), 8))}${domain}`;
}

/**
 * O token foi emitido (iat, em segundos) antes da última mudança de palavra-passe? Compara em segundos inteiros:
 * o token devolvido logo após a redefinição (mesmo segundo) continua válido; os anteriores deixam de valer.
 */
export function tokenPredatesPasswordChange(issuedAtSeconds: number | undefined, passwordChangedAt: Date | null | undefined): boolean {
  if (!passwordChangedAt || typeof issuedAtSeconds !== "number") return false;
  return issuedAtSeconds < Math.floor(passwordChangedAt.getTime() / 1000);
}
