import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ADMIN_PROFILES, PERMISSIONS, PROFILE_PERMISSIONS, permissionsFor, profilesWith } from "../src/lib/permissions.js";

describe("permissionsFor", () => {
  it("cliente não tem nenhuma permissão de administração", () => {
    expect(permissionsFor(["CUSTOMER"], ["ORDERS"])).toEqual([]);
  });

  it("SUPER_ADMIN tem todas, incluindo gerir a equipa", () => {
    expect(permissionsFor(["SUPER_ADMIN"], [])).toEqual([...PERMISSIONS]);
    expect(permissionsFor(["SUPER_ADMIN"], [])).toContain("team.manage");
  });

  it("ADMIN sem perfis não tem nenhuma permissão", () => {
    expect(permissionsFor(["ADMIN"], [])).toEqual([]);
  });

  it("ADMIN com todos os perfis tem tudo menos gerir a equipa (é o que os admins antigos recebem na migração)", () => {
    const all = permissionsFor(["ADMIN"], [...ADMIN_PROFILES]);
    expect(all).toEqual(PERMISSIONS.filter((permission) => permission !== "team.manage"));
  });

  it("perfil Encomendas gere encomendas mas não mexe em pagamentos, catálogo nem chat", () => {
    const orders = permissionsFor(["ADMIN"], ["ORDERS"]);
    expect(orders).toContain("orders.manage");
    expect(orders).toContain("payments.view");
    expect(orders).not.toContain("payments.manage");
    expect(orders).not.toContain("catalog.products");
    expect(orders).not.toContain("support.manage");
  });

  it("perfil Catálogo só vê catálogo (sem encomendas, pagamentos nem painel de vendas)", () => {
    expect(permissionsFor(["ADMIN"], ["CATALOG"])).toEqual(["catalog.products", "catalog.categories"]);
  });

  it("vários perfis somam permissões, sem repetir", () => {
    const merged = permissionsFor(["ADMIN"], ["ORDERS", "FINANCE"]);
    expect(merged.filter((permission) => permission === "orders.view")).toHaveLength(1);
    expect(merged).toContain("payments.manage");
    expect(merged).toContain("orders.manage");
  });

  it("ignora perfis desconhecidos em vez de dar permissões", () => {
    expect(permissionsFor(["ADMIN"], ["INVENTADO"])).toEqual([]);
  });

  it("ninguém além do SUPER_ADMIN pode gerir a equipa", () => {
    for (const profile of ADMIN_PROFILES) expect(PROFILE_PERMISSIONS[profile]).not.toContain("team.manage");
  });
});

describe("profilesWith (a quem notificar)", () => {
  it("pagamentos a rever vão para Finanças", () => {
    expect(profilesWith(["payments.manage"])).toEqual(["FINANCE"]);
  });
  it("venda paga vai para Finanças e Encomendas", () => {
    expect(profilesWith(["payments.manage", "orders.manage"])).toEqual(["ORDERS", "FINANCE"]);
  });
  it("chat vai para Suporte", () => {
    expect(profilesWith(["support.manage"])).toEqual(["SUPPORT"]);
  });
});

describe("rotas de equipa e áreas exigem autenticação", () => {
  const cases: Array<[string, string]> = [
    ["GET", "/api/v1/admin/team"],
    ["POST", "/api/v1/admin/team"],
    ["PUT", "/api/v1/admin/team/x/profiles"],
    ["DELETE", "/api/v1/admin/team/x"],
    ["GET", "/api/v1/admin/users"],
    ["GET", "/api/v1/admin/orders"],
    ["GET", "/api/v1/admin/products"],
    ["GET", "/api/v1/admin/payments/pending-review"],
    ["GET", "/api/v1/admin/payment-settings"],
    ["GET", "/api/v1/admin/stats"]
  ];
  for (const [method, url] of cases) {
    it(`${method} ${url} sem token devolve 401`, async () => {
      const app = buildApp();
      const response = await app.inject({ method: method as "GET", url });
      expect(response.statusCode).toBe(401);
      await app.close();
    });
  }
});
