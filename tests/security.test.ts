import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("Security", () => {
  it("requires authentication for the customer profile", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/users/me" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires authentication for admin users", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/users" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects malformed bearer tokens", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/users/me", headers: { authorization: "Bearer invalid" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects webhooks without the shared secret", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/payments/abc/webhook", payload: { status: "SUCCESS" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects webhooks with a wrong secret", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/payments/abc/webhook", headers: { "x-twisisa-webhook-secret": "wrong" }, payload: { status: "SUCCESS" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("validates the webhook body after authentication", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/payments/abc/webhook", headers: { "x-twisisa-webhook-secret": "test-webhook-secret" }, payload: {} });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("requires authentication for the chat", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/chat/conversations" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires authentication for admin chat moderation", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/chat/conversations" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires authentication for admin product management", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/products", payload: { name: "X", priceMzn: 1 } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("requires authentication for manual order status advance", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/admin/orders/abc/status", payload: { status: "SHIPPED" } });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
