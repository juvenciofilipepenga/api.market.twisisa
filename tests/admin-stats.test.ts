import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /admin/stats", () => {
  it("recusa pedidos sem sessão (não chega à base de dados)", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/admin/stats" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
