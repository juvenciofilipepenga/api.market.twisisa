import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { bucketOf, ORDER_BUCKETS } from "../src/services/orderBuckets.js";
import {
  availableStock, CatalogError, describeOptions, effectivePrice, legacyFromOptions, normalizeOptions, normalizeVariants,
  optionKeyOf, optionsFromLegacy, parseAttributeValue, resolveOrderLine, variantLabel
} from "../src/services/catalog.js";

const code = (fn: () => unknown) => {
  try { fn(); } catch (error) { return error instanceof CatalogError ? error.code : `other:${String(error)}`; }
  return "no-error";
};

describe("opções e chave canónica", () => {
  it("a chave ignora a ordem e as maiúsculas", () => {
    expect(optionKeyOf({ Tamanho: "M", Cor: "#000000" })).toBe("cor=#000000|tamanho=m");
    expect(optionKeyOf({ cor: "#000000", TAMANHO: " m " })).toBe("cor=#000000|tamanho=m");
  });

  it("coincide com a chave que a migração 012 calcula para as variantes antigas", () => {
    // SQL: 'cor=' || lower(colorHex) || '|tamanho=' || lower(btrim(size))
    expect(optionKeyOf(optionsFromLegacy("#FF0000", " XL "))).toBe("cor=#ff0000|tamanho=xl");
    expect(optionKeyOf(optionsFromLegacy("#FF0000", null))).toBe("cor=#ff0000");
    expect(optionKeyOf(optionsFromLegacy(null, "42"))).toBe("tamanho=42");
  });

  it("cor e tamanho antigos convertem-se para opções e voltam", () => {
    const options = optionsFromLegacy("#112233", "L");
    expect(options).toEqual({ Cor: "#112233", Tamanho: "L" });
    expect(legacyFromOptions(options)).toEqual({ colorHex: "#112233", size: "L" });
  });

  it("opções novas (Capacidade, Configuração) não precisam de cor nem tamanho", () => {
    expect(legacyFromOptions({ Capacidade: "256 GB" })).toEqual({ colorHex: null, size: null });
    expect(variantLabel({ Cor: "#000000", Capacidade: "256 GB" })).toBe("Cor: #000000 · Capacidade: 256 GB");
  });

  it("limpa espaços e vazios, e limita o número de opções", () => {
    expect(normalizeOptions({ " Cor ": " #000000 ", Vazio: "  " })).toEqual({ Cor: "#000000" });
    const seven = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`O${i}`, "x"]));
    expect(code(() => normalizeOptions(seven))).toBe("TOO_MANY_OPTIONS");
  });
});

describe("validação de variantes", () => {
  it("aceita o formato antigo e o novo", () => {
    const list = normalizeVariants([
      { colorHex: "#000000", size: "M", stock: 3 },
      { options: { Cor: "#ffffff", Tamanho: "M" }, stock: 2, sku: "TS-BR-M", priceMzn: 1500 }
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]!.optionKey).toBe("cor=#000000|tamanho=m");
    expect(list[1]).toMatchObject({ sku: "TS-BR-M", priceMzn: 1500, colorHex: "#ffffff", size: "M", active: true });
  });

  it("rejeita combinações duplicadas, mesmo com maiúsculas ou formato diferente", () => {
    expect(code(() => normalizeVariants([{ colorHex: "#000000", size: "M", stock: 1 }, { options: { tamanho: "m", cor: "#000000" }, stock: 1 }]))).toBe("DUPLICATE_VARIANT");
  });

  it("rejeita uma variante sem nenhuma opção", () => {
    expect(code(() => normalizeVariants([{ stock: 1 }]))).toBe("VARIANT_ATTRIBUTE_REQUIRED");
  });

  it("rejeita SKUs repetidos (sem distinguir maiúsculas)", () => {
    expect(code(() => normalizeVariants([{ options: { Capacidade: "128 GB" }, sku: "abc", stock: 1 }, { options: { Capacidade: "256 GB" }, sku: "ABC", stock: 1 }]))).toBe("DUPLICATE_SKU");
  });

  it("permite o mesmo valor em opções diferentes e SKU vazio", () => {
    const list = normalizeVariants([{ options: { Configuração: "8 GB / 256 GB" }, sku: "  ", stock: 1 }, { options: { Configuração: "16 GB / 512 GB" }, stock: 1 }]);
    expect(list.map((v) => v.sku)).toEqual([null, null]);
  });
});

describe("preço e stock: fonte de verdade", () => {
  it("o preço da variante substitui o do produto; vazio herda", () => {
    expect(effectivePrice(1000, 1200)).toBe(1200);
    expect(effectivePrice(1000, null)).toBe(1000);
    expect(effectivePrice(1000, undefined)).toBe(1000);
  });

  it("produto simples usa o stock do produto", () => {
    expect(availableStock({ stock: 7 })).toBe(7);
    expect(availableStock({ stock: 7, variants: [] })).toBe(7);
  });

  it("produto com variantes soma só as ativas e ignora o stock do produto", () => {
    expect(availableStock({ stock: 999, variants: [{ stock: 2, active: true }, { stock: 3, active: true }, { stock: 50, active: false }] })).toBe(5);
  });

  it("opções mostradas ao cliente vêm só das variantes ativas reais", () => {
    const defs = describeOptions([
      { options: { Cor: "#000000", Tamanho: "M" } },
      { options: { Cor: "#ffffff", Tamanho: "M" } },
      { options: { Cor: "#ff0000", Tamanho: "XL" }, active: false }
    ]);
    expect(defs).toEqual([
      { name: "Cor", kind: "COLOR", values: ["#000000", "#ffffff"] },
      { name: "Tamanho", kind: "TEXT", values: ["M"] }
    ]);
  });
});

describe("características por categoria", () => {
  const def = (type: string, options: unknown = []) => ({ id: "a1", name: "Campo", type, options, required: false });

  it("converte cada tipo para a coluna certa", () => {
    expect(parseAttributeValue(def("TEXT"), " Dell ")).toEqual({ valueText: "Dell", valueNumber: null, valueBool: null });
    expect(parseAttributeValue(def("NUMBER"), "15,6")).toEqual({ valueText: null, valueNumber: 15.6, valueBool: null });
    expect(parseAttributeValue(def("MEASURE"), 256)).toEqual({ valueText: null, valueNumber: 256, valueBool: null });
    expect(parseAttributeValue(def("BOOLEAN"), "true")).toEqual({ valueText: null, valueNumber: null, valueBool: true });
    expect(parseAttributeValue(def("SELECT", ["SSD", "HDD"]), "SSD")).toEqual({ valueText: "SSD", valueNumber: null, valueBool: null });
  });

  it("vazio significa 'sem valor'", () => {
    expect(parseAttributeValue(def("TEXT"), "")).toBeNull();
    expect(parseAttributeValue(def("NUMBER"), null)).toBeNull();
  });

  it("rejeita valores que não correspondem ao tipo", () => {
    expect(code(() => parseAttributeValue(def("NUMBER"), "muito"))).toBe("ATTRIBUTE_INVALID_VALUE");
    expect(code(() => parseAttributeValue(def("BOOLEAN"), "talvez"))).toBe("ATTRIBUTE_INVALID_VALUE");
    expect(code(() => parseAttributeValue(def("SELECT", ["SSD", "HDD"]), "NVMe"))).toBe("ATTRIBUTE_INVALID_VALUE");
  });
});

describe("linha de encomenda: preço e disponibilidade decididos no servidor", () => {
  const variant = (over: Record<string, unknown> = {}) => ({ id: "v1", active: true, stock: 5, priceMzn: null as number | null, sku: "SKU-1", options: { Cor: "#000000", Tamanho: "M" }, colorHex: "#000000", size: "M", ...over });
  const product = (over: Record<string, unknown> = {}) => ({ id: "p1", name: "T-shirt", priceMzn: 1000, stock: 10, variants: [] as ReturnType<typeof variant>[], ...over });

  it("compra de produto sem variantes: preço e stock do produto", () => {
    const line = resolveOrderLine(product(), { quantity: 3 });
    expect(line.variant).toBeUndefined();
    expect(line.unitPrice).toBe(1000);
    expect(line.label).toBeNull();
  });

  it("compra de variante válida: herda o preço do produto e guarda texto e SKU", () => {
    const line = resolveOrderLine(product({ variants: [variant()] }), { variantId: "v1", quantity: 2 });
    expect(line.unitPrice).toBe(1000);
    expect(line.label).toBe("Cor: #000000 · Tamanho: M");
    expect(line.sku).toBe("SKU-1");
  });

  it("variante com preço próprio: o servidor usa esse preço", () => {
    const line = resolveOrderLine(product({ variants: [variant({ priceMzn: 1350 })] }), { variantId: "v1", quantity: 1 });
    expect(line.unitPrice).toBe(1350);
  });

  it("variante inexistente, de outro produto ou inativa é rejeitada", () => {
    expect(code(() => resolveOrderLine(product({ variants: [variant()] }), { variantId: "nao-existe", quantity: 1 }))).toBe("VARIANT_NOT_FOUND");
    expect(code(() => resolveOrderLine(product({ variants: [variant({ active: false })] }), { variantId: "v1", quantity: 1 }))).toBe("VARIANT_NOT_FOUND");
  });

  it("produto sem variantes não aceita um variantId inventado", () => {
    expect(code(() => resolveOrderLine(product(), { variantId: "v1", quantity: 1 }))).toBe("VARIANT_NOT_FOUND");
  });

  it("produto com variantes exige que se escolha uma", () => {
    expect(code(() => resolveOrderLine(product({ variants: [variant()] }), { quantity: 1 }))).toBe("VARIANT_REQUIRED");
  });

  it("stock insuficiente: conta o da variante, não o do produto", () => {
    expect(code(() => resolveOrderLine(product({ stock: 999, variants: [variant({ stock: 1 })] }), { variantId: "v1", quantity: 2 }))).toBe("INSUFFICIENT_STOCK");
    expect(code(() => resolveOrderLine(product({ stock: 2 }), { quantity: 3 }))).toBe("INSUFFICIENT_STOCK");
  });

  it("variante antiga só com colorHex/size (sem options) continua a funcionar", () => {
    const old = variant({ options: {}, colorHex: "#FF0000", size: "42" });
    const line = resolveOrderLine(product({ variants: [old] }), { variantId: "v1", quantity: 1 });
    expect(line.label).toBe("Cor: #FF0000 · Tamanho: 42");
  });
});

describe("gestão de catálogo exige administrador", () => {
  it.each([
    ["POST", "/api/v1/admin/products"],
    ["PATCH", "/api/v1/admin/products/abc"],
    ["GET", "/api/v1/admin/categories/abc/attributes"],
    ["POST", "/api/v1/admin/categories/abc/attributes"],
    ["PATCH", "/api/v1/admin/category-attributes/abc"],
    ["DELETE", "/api/v1/admin/category-attributes/abc"],
    ["GET", "/api/v1/admin/attention"],
    ["GET", "/api/v1/admin/history"],
    ["GET", "/api/v1/admin/orders"]
  ])("%s %s → 401 sem sessão", async (method, url) => {
    const app = buildApp();
    const res = await app.inject({ method: method as "GET" | "POST" | "PATCH" | "DELETE", url });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("separadores de encomendas do admin", () => {
  const ALL = ["PENDING_PAYMENT", "PAYMENT_REVIEW", "PAID", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLATION_REQUESTED", "CANCELLED", "REFUND_PENDING", "REFUNDED"];

  it("todos os estados caem em exatamente um separador", () => {
    const placed = [...ORDER_BUCKETS.action, ...ORDER_BUCKETS.ongoing, ...ORDER_BUCKETS.done];
    expect([...placed].sort()).toEqual([...ALL].sort());
    expect(new Set(placed).size).toBe(ALL.length);
  });

  it("o que espera pelo admin vai para 'Precisa de ação'", () => {
    for (const s of ["PAYMENT_REVIEW", "PAID", "CANCELLATION_REQUESTED", "REFUND_PENDING"] as const) expect(bucketOf(s)).toBe("action");
    expect(bucketOf("PENDING_PAYMENT")).toBe("ongoing");
    expect(bucketOf("DELIVERED")).toBe("done");
  });
});
