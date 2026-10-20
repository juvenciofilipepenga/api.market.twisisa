import { OrderStatus, PaymentStatus } from "../generated/prisma/client.js";
import { env, groqConfigured } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { buildSystemPrompt, interpretModelReply, pickKnowledge, type KnowledgeEntry } from "./chatKnowledge.js";

export const DEFAULT_ASSISTANT_NAME = "Assistente Twisisa";
const SETTINGS_ID = "default";

export interface AiSettingsView {
  enabled: boolean;
  assistantName: string;
  instructions: string;
}

// Sem linha na BD (migração acabada de correr), a IA fica ligada com os valores por omissão.
export async function loadAiSettings(): Promise<AiSettingsView> {
  const row = await prisma.chatAiSettings.findUnique({ where: { id: SETTINGS_ID } });
  return {
    enabled: row?.enabled ?? true,
    assistantName: row?.assistantName?.trim() || DEFAULT_ASSISTANT_NAME,
    instructions: row?.instructions ?? ""
  };
}

export function greetingMessage(settings: AiSettingsView): string {
  if (!settings.enabled) return "Olá! Escreva a sua mensagem e a nossa equipa responde assim que possível.";
  return `Olá! Sou ${settings.assistantName}, da Twisisa Market. Em que posso ajudar?`;
}

const orderStatusLabels: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "à espera de pagamento",
  PAYMENT_REVIEW: "com o pagamento em análise",
  PAID: "paga, a preparar envio",
  PROCESSING: "em processamento",
  READY_FOR_SHIPMENT: "pronta para envio",
  SHIPPED: "já enviada",
  OUT_FOR_DELIVERY: "a caminho da entrega",
  DELIVERED: "entregue",
  CANCELLATION_REQUESTED: "com pedido de cancelamento em análise",
  CANCELLED: "cancelada",
  REFUND_PENDING: "com reembolso a ser processado",
  REFUNDED: "reembolsada"
};

const paymentStatusLabels: Record<PaymentStatus, string> = {
  INITIATED: "iniciado",
  AUTHENTICATING: "a ser autenticado",
  SUCCESS: "confirmado",
  FAILED: "falhou",
  TIMEOUT: "expirou",
  PENDING_CONFIRMATION: "à espera de confirmação",
  CANCELLED: "cancelado",
  REFUNDED: "reembolsado",
  PAYMENT_PENDING: "pendente",
  PROOF_SUBMITTED: "com comprovativo em análise",
  UNDER_REVIEW: "em revisão",
  PAYMENT_CONFIRMED: "confirmado",
  PAYMENT_REJECTED: "rejeitado",
  REFUND_PENDING: "com reembolso pendente",
  REFUNDED_LEGACY: "reembolsado"
};

// Só dados do PRÓPRIO cliente (userId vem do token, nunca do texto da mensagem) e só o estado, sem moradas nem valores.
async function loadCustomerContext(userId: string): Promise<string[]> {
  const [order, payment] = await Promise.all([
    prisma.order.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } }),
    prisma.payment.findFirst({ where: { order: { userId } }, orderBy: { createdAt: "desc" }, include: { order: true } })
  ]);
  const lines: string[] = [];
  if (order) lines.push(`Última encomenda ${order.orderNumber}: ${orderStatusLabels[order.status]}.`);
  else lines.push("O cliente ainda não tem encomendas.");
  if (payment) lines.push(`Último pagamento (ref. ${payment.reference}, encomenda ${payment.order.orderNumber}): ${paymentStatusLabels[payment.status]}.`);
  return lines;
}

const humanRequestPattern = /\b(humano|atendente|pessoa|operador|falar com alguem|falar com algu[ée]m)\b/i;
const HANDOFF_REPLY = "Sem problema, vou encaminhar para um atendente. Aguarde só um instante.";
const BUSY_REPLY = "Estou com dificuldade em responder agora. Vou encaminhar para um atendente.";

export type ChatHistory = Array<{ role: "user" | "assistant"; content: string }>;
export interface AiResult {
  /** null = a IA está desligada: não há resposta automática, a mensagem fica para a equipa. */
  reply: string | null;
  escalate: boolean;
  usedKnowledge: string[];
}

async function callGroq(systemPrompt: string, history: ChatHistory): Promise<{ reply: string; escalate: boolean } | null> {
  let response: Response;
  try {
    response = await fetch(new URL("/chat/completions", env.GROQ_API_BASE_URL).toString(), {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        messages: [{ role: "system", content: systemPrompt }, ...history]
      })
    });
  } catch {
    // Timeout ou falha de rede: não deixa o cliente pendurado, passa a um atendente.
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as { choices?: Array<{ message?: { content?: string } }> } | null;
  const text = body?.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  return interpretModelReply(text);
}

async function loadKnowledge(query: string): Promise<KnowledgeEntry[]> {
  const rows = await prisma.chatKnowledge.findMany({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: { id: true, title: true, content: true }
  });
  return pickKnowledge(rows, query);
}

/**
 * Resposta automática a uma mensagem do cliente.
 * `userId` null = teste do admin (sem dados de nenhuma conta).
 */
export async function generateAiReply(input: { userId: string | null; text: string; history: ChatHistory; settings?: AiSettingsView }): Promise<AiResult> {
  const settings = input.settings ?? (await loadAiSettings());
  if (!settings.enabled) return { reply: null, escalate: true, usedKnowledge: [] };
  if (humanRequestPattern.test(input.text)) return { reply: HANDOFF_REPLY, escalate: true, usedKnowledge: [] };
  if (!groqConfigured) {
    return { reply: "De momento não consigo responder a essa pergunta automaticamente. Vou encaminhar para um atendente.", escalate: true, usedKnowledge: [] };
  }
  const [knowledge, customerContext] = await Promise.all([
    loadKnowledge(input.text),
    input.userId ? loadCustomerContext(input.userId) : Promise.resolve([] as string[])
  ]);
  const systemPrompt = buildSystemPrompt({ assistantName: settings.assistantName, instructions: settings.instructions, knowledge, customerContext });
  const result = await callGroq(systemPrompt, input.history);
  const usedKnowledge = knowledge.map((entry) => entry.title);
  if (!result) return { reply: BUSY_REPLY, escalate: true, usedKnowledge };
  return { ...result, usedKnowledge };
}
