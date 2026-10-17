import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

// Estes testes não precisam de base de dados: validam tudo o que é recusado ANTES de lhe tocar.
const post = async (url: string, payload: unknown) => {
  const app = buildApp();
  const response = await app.inject({ method: "POST", url, payload: payload as object });
  await app.close();
  return response;
};

describe("Password recovery (input validation)", () => {
  it("rejects a malformed email on forgot-password", async () => {
    const response = await post("/api/v1/auth/forgot-password", { email: "not-an-email" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("rejects a missing body on forgot-password", async () => {
    expect((await post("/api/v1/auth/forgot-password", undefined)).statusCode).toBe(400);
  });

  it("treats a malformed token as invalid without touching the database", async () => {
    const check = await post("/api/v1/auth/reset-password/check", { token: "abc" });
    expect(check.statusCode).toBe(400);
    expect(check.json()).toEqual({ error: "INVALID_TOKEN" });
    const reset = await post("/api/v1/auth/reset-password", { token: "abc", password: "a-long-enough-password" });
    expect(reset.statusCode).toBe(400);
    expect(reset.json()).toEqual({ error: "INVALID_TOKEN" });
  });

  it("rejects a short new password before looking at the token", async () => {
    const response = await post("/api/v1/auth/reset-password", { token: "x".repeat(43), password: "short" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("rate limits forgot-password per client", async () => {
    const app = buildApp();
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await app.inject({ method: "POST", url: "/api/v1/auth/forgot-password", payload: { email: "nope" } })).statusCode);
    }
    await app.close();
    expect(statuses.slice(0, 5).every((code) => code === 400)).toBe(true);
    expect(statuses[6]).toBe(429);
  });
});
