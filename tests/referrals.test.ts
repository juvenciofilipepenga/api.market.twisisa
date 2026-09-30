import { beforeEach, describe, expect, it, vi } from "vitest";

// A base de dados e as notificações são simuladas: estes testes verificam a lógica de convites,
// não o Postgres.
const prismaMock = vi.hoisted(() => ({
  user: { count: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  order: { count: vi.fn() }
}));
const notifyMock = vi.hoisted(() => ({ notifyUser: vi.fn(), notifyAdmins: vi.fn() }));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/services/notifications.js", () => notifyMock);

import { buildApp } from "../src/app.js";
import {
  QUALIFYING_ORDER_STATES,
  firstName,
  normalizeReferralCode,
  notifyReferralCompletedIfFirst,
  referralStats
} from "../src/services/referrals.js";

beforeEach(() => { vi.clearAllMocks(); });

describe("normalizeReferralCode", () => {
  it("accepts cuid-like codes and trims spaces", () => {
    expect(normalizeReferralCode("  clx8f2k1a0000abcd1234efgh ")).toBe("clx8f2k1a0000abcd1234efgh");
  });
  it("rejects empty, too short, too long and unsafe input", () => {
    expect(normalizeReferralCode(undefined)).toBeNull();
    expect(normalizeReferralCode("abc")).toBeNull();
    expect(normalizeReferralCode("a".repeat(65))).toBeNull();
    expect(normalizeReferralCode("abc def ghi")).toBeNull();
    expect(normalizeReferralCode("abc'; DROP TABLE")).toBeNull();
  });
});

describe("firstName", () => {
  it("returns only the first word", () => {
    expect(firstName("Maria da Silva")).toBe("Maria");
    expect(firstName("  João ")).toBe("João");
  });
});

describe("referralStats", () => {
  it("counts invited and completed separately and derives pending", async () => {
    prismaMock.user.count.mockResolvedValueOnce(5).mockResolvedValueOnce(2);
    expect(await referralStats("u1")).toEqual({ invited: 5, completed: 2, pending: 3 });
    const completedQuery = prismaMock.user.count.mock.calls[1]?.[0];
    expect(completedQuery.where.referredById).toBe("u1");
    expect(completedQuery.where.orders.some.status.in).toEqual(QUALIFYING_ORDER_STATES);
  });
  it("never returns a negative pending value", async () => {
    prismaMock.user.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    expect((await referralStats("u1")).pending).toBe(0);
  });
  it("does not count cancelled or refunded orders as completed", () => {
    expect(QUALIFYING_ORDER_STATES).not.toContain("CANCELLED");
    expect(QUALIFYING_ORDER_STATES).not.toContain("REFUNDED");
    expect(QUALIFYING_ORDER_STATES).not.toContain("PENDING_PAYMENT");
  });
});

describe("notifyReferralCompletedIfFirst", () => {
  it("does nothing when the buyer was not invited", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ name: "Ana", referredById: null });
    expect(await notifyReferralCompletedIfFirst("b1", "o1")).toBe(false);
    expect(notifyMock.notifyUser).not.toHaveBeenCalled();
  });
  it("notifies the inviter on the first qualifying order", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ name: "Ana Costa", referredById: "inviter1" });
    prismaMock.order.count.mockResolvedValue(1);
    expect(await notifyReferralCompletedIfFirst("b1", "o1")).toBe(true);
    expect(notifyMock.notifyUser).toHaveBeenCalledWith(expect.objectContaining({ userId: "inviter1", type: "REFERRAL", data: { orderId: "o1" } }));
    expect(notifyMock.notifyUser.mock.calls[0]?.[0].message).toContain("Ana");
    expect(notifyMock.notifyUser.mock.calls[0]?.[0].message).not.toContain("Costa");
  });
  it("does not notify again on later paid orders", async () => {
    prismaMock.user.findUnique.mockResolvedValue({ name: "Ana", referredById: "inviter1" });
    prismaMock.order.count.mockResolvedValue(2);
    expect(await notifyReferralCompletedIfFirst("b1", "o2")).toBe(false);
    expect(notifyMock.notifyUser).not.toHaveBeenCalled();
  });
});

describe("referral routes", () => {
  it("requires authentication for /referrals/me", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/referrals/me" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for a malformed code without touching the database", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/referrals/lookup/abc" });
    expect(response.statusCode).toBe(404);
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns only the inviter's first name for a valid code", async () => {
    prismaMock.user.findFirst.mockResolvedValue({ id: "u1", name: "Maria da Silva" });
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/referrals/lookup/clx8f2k1a0000abcd1234efgh" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, inviterFirstName: "Maria" });
    await app.close();
  });

  it("returns 404 when no active user owns the code", async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/referrals/lookup/clx8f2k1a0000abcd1234efgh" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects a non-string referralCode at registration", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST", url: "/api/v1/auth/register",
      payload: { name: "Ana Costa", email: "ana@example.com", password: "uma-palavra-passe-longa", referralCode: 123 }
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
