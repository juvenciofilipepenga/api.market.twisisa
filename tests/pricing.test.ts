import { describe, expect, it } from "vitest";
import { computePricing, levelOf } from "../src/services/pricing.js";

const base = { purchaseMzn: 10_000, taxPct: 0, transportMzn: 0, otherCostsMzn: 0, returnPct: 0, commissionPct: 0, discountPct: 0 };

describe("computePricing", () => {
  it("o custo total inclui taxas e transporte (compra 10 000, taxas 16%, transporte 400 → 12 000)", () => {
    const r = computePricing({ ...base, taxPct: 16, transportMzn: 400, returnPct: 80 });
    expect(r.costTotal).toBe(12_000);
    expect(r.listPrice).toBe(21_600); // sem 21 601 por erro de vírgula flutuante
    expect(r.customerPrice).toBe(21_600);
    expect(r.profit).toBe(9_600);
    expect(r.returnPct).toBe(80);
    expect(r.level).toBe("excellent");
  });

  it("a comissão é % do preço de venda: o preço sobe para a pagar e o retorno desejado mantém-se", () => {
    const r = computePricing({ ...base, returnPct: 40, commissionPct: 10 });
    expect(r.listPrice).toBe(15_556); // 14 000 ÷ 0,9 = 15 555,56 → arredonda para cima
    expect(r.returnPct).toBeGreaterThanOrEqual(40);
  });

  it("o desconto baixa o preço ao cliente e o retorno real; pode passar de bom a baixo", () => {
    const sem = computePricing({ ...base, returnPct: 35 });
    const com = computePricing({ ...base, returnPct: 35, discountPct: 20 });
    expect(sem.level).toBe("good");
    expect(com.customerPrice).toBe(10_800);
    expect(com.returnPct).toBe(8);
    expect(com.level).toBe("low");
  });

  it("vender abaixo do custo é prejuízo", () => {
    const r = computePricing({ ...base, returnPct: 0, discountPct: 10 });
    expect(r.profit).toBeLessThan(0);
    expect(r.level).toBe("loss");
  });
});

describe("levelOf (limites 30% e 80% por defeito)", () => {
  it.each([[-1, "loss"], [0, "low"], [29.99, "low"], [30, "good"], [50, "good"], [79.99, "good"], [80, "excellent"], [100, "excellent"]] as const)("%s%% → %s", (pct, level) => {
    expect(levelOf(pct)).toBe(level);
  });

  it("respeita limites diferentes definidos pelo admin", () => {
    expect(levelOf(25, { goodFromPct: 20, excellentFromPct: 40 })).toBe("good");
  });
});
