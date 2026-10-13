import { describe, expect, it } from "vitest";
import { findCategory, matchAttribute } from "../src/services/bulkImport.js";

const categories = [
  { id: "c1", name: "Portáteis", slug: "portateis" },
  { id: "c2", name: "Telemóveis", slug: "telemoveis" }
];

describe("importação em massa: categoria pelo nome", () => {
  it("sem categoria no pedido devolve undefined", () => {
    expect(findCategory(categories, {})).toBeUndefined();
  });

  it("encontra por nome, slug ou id, sem ligar a maiúsculas, acentos e espaços", () => {
    expect(findCategory(categories, { category: "Portáteis" })?.id).toBe("c1");
    expect(findCategory(categories, { category: "PORTATEIS" })?.id).toBe("c1");
    expect(findCategory(categories, { category: " telemoveis " })?.id).toBe("c2");
    expect(findCategory(categories, { category: "c2" })?.id).toBe("c2");
  });

  it("categoria pedida que não existe devolve null", () => {
    expect(findCategory(categories, { category: "Frigoríficos" })).toBeNull();
    expect(findCategory(categories, { categoryId: "nao-existe" })).toBeNull();
  });

  it("categoryId tem prioridade sobre o nome", () => {
    expect(findCategory(categories, { categoryId: "c2", category: "Portáteis" })?.id).toBe("c2");
  });
});

describe("importação em massa: característica pelo nome", () => {
  const defs = [
    { id: "a1", key: "memoria-ram", name: "Memória RAM" },
    { id: "a2", key: "ecra", name: "Ecrã" }
  ];

  it("reconhece a característica que já existe na categoria", () => {
    expect(matchAttribute(defs, "memória ram")?.id).toBe("a1");
    expect(matchAttribute(defs, "MEMORIA RAM")?.id).toBe("a1");
    expect(matchAttribute(defs, "Ecra")?.id).toBe("a2");
  });

  it("devolve undefined para o que ainda não existe ou não tem letras", () => {
    expect(matchAttribute(defs, "Processador")).toBeUndefined();
    expect(matchAttribute(defs, "!!!")).toBeUndefined();
  });
});
