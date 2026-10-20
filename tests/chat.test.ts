import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { buildSystemPrompt, interpretModelReply, pickKnowledge, tokenize } from "../src/services/chatKnowledge.js";

const entries = [
  { id: "1", title: "Quanto custa a entrega em Maputo?", content: "A entrega em Maputo custa 150 MZN e demora 1 a 2 dias." },
  { id: "2", title: "Aceitam devoluções?", content: "Aceitamos devoluções até 7 dias após a entrega, com o produto na embalagem." },
  { id: "3", title: "Como pagar com M-Pesa?", content: "Escolha M-Pesa no pagamento e confirme no telemóvel." }
];

describe("chat knowledge", () => {
  it("tokenize ignora acentos, maiúsculas e palavras vazias", () => {
    expect(tokenize("Qual é o PRAZO de entrega, por favor?")).toEqual(["prazo", "entrega", "favor"]);
  });

  it("envia toda a base quando cabe no orçamento", () => {
    expect(pickKnowledge(entries, "qualquer coisa")).toEqual(entries);
  });

  it("com a base maior que o orçamento, escolhe pelas palavras da pergunta", () => {
    const picked = pickKnowledge(entries, "quero devolver, aceitam devoluções?", 120, 15);
    expect(picked.map((entry) => entry.id)).toEqual(["2"]);
  });

  it("sem palavras em comum não envia conhecimento (a IA deve passar a um humano)", () => {
    expect(pickKnowledge(entries, "xyzabc", 120, 15)).toEqual([]);
  });

  it("respeita o número máximo de entradas", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: `entrega ${i}`, content: "entrega rápida" }));
    expect(pickKnowledge(many, "entrega", 6000, 3)).toHaveLength(3);
  });

  it("o prompt leva instruções, conhecimento e dados da conta", () => {
    const prompt = buildSystemPrompt({ assistantName: "Zuri", instructions: "Trata o cliente por você.", knowledge: [entries[0]!], customerContext: ["Última encomenda TM-1: paga."] });
    expect(prompt).toContain("És Zuri");
    expect(prompt).toContain("Trata o cliente por você.");
    expect(prompt).toContain("P: Quanto custa a entrega em Maputo?");
    expect(prompt).toContain("Última encomenda TM-1: paga.");
    expect(prompt).toContain("ESCALATE:");
  });

  it("ESCALATE do modelo passa a um humano sem mostrar o resumo ao cliente", () => {
    const result = interpretModelReply("ESCALATE: cliente quer reembolso");
    expect(result.escalate).toBe(true);
    expect(result.reply).not.toContain("reembolso");
  });

  it("resposta normal do modelo segue para o cliente", () => {
    expect(interpretModelReply("  A entrega custa 150 MZN.  ")).toEqual({ reply: "A entrega custa 150 MZN.", escalate: false });
  });
});

describe("chat routes exigem autenticação", () => {
  const cases: Array<[string, string]> = [
    ["GET", "/api/v1/chat/conversations/x/sync"],
    ["POST", "/api/v1/chat/conversations/x/ai-reply"],
    ["POST", "/api/v1/chat/conversations/x/typing"],
    ["POST", "/api/v1/chat/conversations/x/read"],
    ["GET", "/api/v1/admin/chat/conversations/x/sync"],
    ["POST", "/api/v1/admin/chat/conversations/x/typing"],
    ["POST", "/api/v1/admin/chat/conversations/x/read"],
    ["POST", "/api/v1/admin/chat/conversations/x/ai-resume"],
    ["GET", "/api/v1/admin/chat/ai/settings"],
    ["PUT", "/api/v1/admin/chat/ai/settings"],
    ["GET", "/api/v1/admin/chat/ai/knowledge"],
    ["POST", "/api/v1/admin/chat/ai/knowledge"],
    ["PATCH", "/api/v1/admin/chat/ai/knowledge/x"],
    ["DELETE", "/api/v1/admin/chat/ai/knowledge/x"],
    ["POST", "/api/v1/admin/chat/ai/test"]
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
