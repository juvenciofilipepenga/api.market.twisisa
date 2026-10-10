import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { classifyFailure, uiState } from "../src/services/paymentFlow.js";
import { isProviderFailure, manualDetails, onlineStatus } from "../src/services/paymentSettings.js";
import { normalizeState, pinConfirmed, ZumboPayError } from "../src/services/zumbopay.js";

const SECRET = "test-webhook-secret";
const sign = (ts: string, raw: string) => createHmac("sha256", SECRET).update(`${ts}.${raw}`).digest("hex");

describe("ZumboPay webhook (HMAC)", () => {
  const raw = JSON.stringify({ event: "payment.success", data: { reference: "ZP-1", source_id: "abc" } });

  it("rejects a missing signature", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/zumbopay", headers: { "content-type": "application/json" }, payload: raw });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a wrong signature", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/zumbopay", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": "0".repeat(64) }, payload: raw });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a stale timestamp even with a valid signature (anti-replay)", async () => {
    const app = buildApp();
    const ts = String(Date.now() - 10 * 60_000);
    const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/zumbopay", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sign(ts, raw) }, payload: raw });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a body tampered after signing", async () => {
    const app = buildApp();
    const ts = String(Date.now());
    const res = await app.inject({ method: "POST", url: "/api/v1/webhooks/zumbopay", headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sign(ts, raw) }, payload: raw.replace("ZP-1", "ZP-2") });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("payment endpoints require authentication", () => {
  it.each([
    ["GET", "/api/v1/payments/abc/status"],
    ["POST", "/api/v1/payments/abc/cancel"],
    ["POST", "/api/v1/orders/abc/payments/initiate"],
    ["GET", "/api/v1/admin/invoice-settings"],
    ["PUT", "/api/v1/admin/invoice-settings"],
    ["GET", "/api/v1/admin/invoice-settings/preview"],
    ["POST", "/api/v1/admin/orders/abc/tracking"],
    ["GET", "/api/v1/admin/payment-settings"],
    ["PUT", "/api/v1/admin/payment-settings"],
    ["POST", "/api/v1/admin/payment-settings/reset-degraded"],
    ["POST", "/api/v1/payments/abc/proof"],
    ["POST", "/api/v1/payments/abc/claim"],
    ["GET", "/api/v1/admin/payments/pending-review"]
  ])("%s %s → 401", async (method, url) => {
    const app = buildApp();
    const res = await app.inject({ method: method as "GET" | "POST" | "PUT", url });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("failure classification (what the customer sees)", () => {
  it.each([
    ["INVALID_PIN", "Incorrect PIN", "WRONG_PIN"],
    [undefined, "PIN incorrecto", "WRONG_PIN"],
    ["INSUFFICIENT_FUNDS", "Insufficient funds", "INSUFFICIENT_FUNDS"],
    [undefined, "Saldo insuficiente", "INSUFFICIENT_FUNDS"],
    [undefined, "Request timeout", "TIMEOUT"],
    ["CANCELLED", "Cancelled by user", "CANCELLED"],
    [undefined, "something odd", "UNKNOWN"]
  ])("%s / %s → %s", (code, description, kind) => {
    expect(classifyFailure(code, description)).toBe(kind);
  });
});

describe("ZumboPay status mapping", () => {
  it("only success/completed/paid count as success", () => {
    for (const s of ["success", "COMPLETED", "paid"]) expect(normalizeState(s)).toBe("success");
    for (const s of ["failed", "cancelled", "expired"]) expect(normalizeState(s)).toBe("failed");
    for (const s of ["pending", "processing", "", undefined]) expect(normalizeState(s)).toBe("pending");
  });

  it("e-Mola needs proof of PIN", () => {
    expect(pinConfirmed({})).toBe(false);
    expect(pinConfirmed({ status: "success" })).toBe(false);
    expect(pinConfirmed({ pin_verified: true })).toBe(true);
    expect(pinConfirmed({ provider_status: "PIN_CONFIRMED" })).toBe(true);
    expect(pinConfirmed({ metadata: { emola_pin_ok: true } })).toBe(true);
  });

  it("maps stored statuses to UI states (success only for confirmed ones)", () => {
    expect(uiState("SUCCESS")).toBe("success");
    expect(uiState("PAYMENT_CONFIRMED")).toBe("success");
    for (const s of ["INITIATED", "AUTHENTICATING", "PENDING_CONFIRMATION", "PROOF_SUBMITTED"] as const) expect(uiState(s)).toBe("pending");
    for (const s of ["FAILED", "TIMEOUT", "CANCELLED", "PAYMENT_REJECTED"] as const) expect(uiState(s)).toBe("failed");
  });
});

describe("fallback rules (ZumboPay down → manual payment)", () => {
  it("counts only provider-side problems as ZumboPay failures", () => {
    expect(isProviderFailure(new ZumboPayError("NETWORK", "x"))).toBe(true);
    expect(isProviderFailure(new ZumboPayError("BAD_RESPONSE", "x", 502))).toBe(true);
    expect(isProviderFailure(new ZumboPayError("NOT_CONFIGURED", "x"))).toBe(true);
    for (const status of [401, 403, 429, 500, 503]) expect(isProviderFailure(new ZumboPayError("REJECTED", "x", status))).toBe(true);
    // número inválido / pedido mal formado = culpa do cliente, não abre o disjuntor
    expect(isProviderFailure(new ZumboPayError("REJECTED", "invalid phone", 422))).toBe(false);
    expect(isProviderFailure(new Error("boom"))).toBe(false);
  });

  it("online status: switched off, tripped breaker, or fine", () => {
    const base = { onlineEnabled: true, zpDegradedUntil: null } as never;
    expect(onlineStatus(base)).toBe("ok");
    expect(onlineStatus({ onlineEnabled: false, zpDegradedUntil: null } as never)).toBe("disabled");
    expect(onlineStatus({ onlineEnabled: true, zpDegradedUntil: new Date(Date.now() + 60_000) } as never)).toBe("degraded");
    expect(onlineStatus({ onlineEnabled: true, zpDegradedUntil: new Date(Date.now() - 60_000) } as never)).toBe("ok");
  });

  it("manual payment only shows when at least one destination is filled in", () => {
    const empty = { manualEnabled: true, mpesaNumber: null, emolaNumber: null, bankNib: null } as never;
    expect(manualDetails(empty).enabled).toBe(false);
    expect(manualDetails({ manualEnabled: true, mpesaNumber: "841234567", mpesaName: "Loja", emolaNumber: null, bankNib: null } as never).enabled).toBe(true);
    expect(manualDetails({ manualEnabled: false, mpesaNumber: "841234567", emolaNumber: null, bankNib: null } as never).enabled).toBe(false);
  });
});
