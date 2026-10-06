import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// Hash fictício: o login compara sempre uma password, mesmo quando o email não existe, para que o tempo
// de resposta não revele que contas existem.
export const DUMMY_PASSWORD_HASH = bcrypt.hashSync("twisisa-dummy-password", 12);

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(userId: string, roles: string[]): string {
  return jwt.sign({ sub: userId, roles }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"]
  });
}

export function verifyAccessToken(token: string): { sub: string; roles: string[] } {
  const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload & { sub?: string; roles?: unknown };
  if (!payload.sub) throw new Error("INVALID_TOKEN");
  const roles = Array.isArray(payload.roles) && payload.roles.every((r) => typeof r === "string")
    ? payload.roles
    : [];
  return { sub: payload.sub, roles };
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function randomReference(prefix: string): string {
  return `${prefix}-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}
