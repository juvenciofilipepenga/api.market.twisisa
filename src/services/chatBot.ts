import { OrderStatus, PaymentStatus } from "../generated/prisma/client.js";
import { env, groqConfigured } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

export const MENU_OPTIONS = [
  { key: "1", label: "Problemas no pagamento" },
  { key: "2", label: "Estado da minha encomenda" },
  { key: "3", label: "Falar com um atendente" }
] as const;

export function greetingMessage(): string {
  const lines = MENU_OPTIONS.map((option) => `${option.key}. ${option.label}`).join("\n");
  return `Olá! Sou o assistente da Twisisa Market. Como podemos ajudar?\n${lines}\n\nPode responder com o número da opção ou escrever a sua dúvida.`;
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

async function answerPaymentStatus(userId: string): Promise<string> {
  const payment = await prisma.payment.findFirst({
    where: { order: { userId } },
    orderBy: { createdAt: "desc" },
    include: { order: true }
  });
  if (!payment) return "Ainda não encontrei nenhum pagamento associado à sua conta. Pode indicar o número da encomenda?";
  return `O último pagamento (ref. ${payment.reference}, encomenda ${payment.order.orderNumber}) está ${paymentStatusLabels[payment.status]}. Se precisar de mais detalhes ou quiser reportar um problema, escreva "atendente".`;
}

async function answerOrderStatus(userId: string): Promise<string> {
  const order = await prisma.order.findFirst({ where: { userId }, orderBy: { createdAt: "desc" } });
  if (!order) return "Ainda não encontrei nenhuma encomenda na sua conta.";
  return `A sua última encomenda (${order.orderNumber}) está ${orderStatusLabels[order.status]}. Se achar que está a demorar mais do que devia, escreva "atendente" para falarmos com um humano.`;
}

const humanRequestPattern = /\b(humano|atendente|pessoa|operador|falar com alguem|falar com algu[ée]m)\b/i;

async function askGroq(history: Array<{ role: "user" | "assistant"; content: string }>): Promise<{ reply: string; escalate: boolean }> {
  if (!groqConfigured) {
    return { reply: "De momento não consigo responder a essa pergunta automaticamente. Vou encaminhar para um atendente.", escalate: true };
  }
  const systemPrompt = [
    "És o assistente de suporte da Twisisa Market, uma loja online em Moçambique.",
    "Responde apenas a perguntas simples sobre pagamentos, encomendas, entregas e devoluções.",
    "Sê breve (no máximo 3 frases) e escreve em português.",
    "Se a pergunta exigir acesso a dados que não tens, envolver uma reclamação, um reembolso específico, ou for sobre qualquer outro assunto,",
    'responde APENAS com a palavra "ESCALATE" seguida de dois pontos e um resumo curto do pedido do cliente, sem mais nada.'
  ].join(" ");
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
    return { reply: "Estou com dificuldade em responder agora. Vou encaminhar para um atendente.", escalate: true };
  }
  if (!response.ok) {
    return { reply: "Estou com dificuldade em responder agora. Vou encaminhar para um atendente.", escalate: true };
  }
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) return { reply: "Vou encaminhar a sua questão para um atendente.", escalate: true };
  if (/^ESCALATE\s*:/i.test(text)) return { reply: "Essa questão precisa de um atendente humano — já vou encaminhar. Aguarde um instante.", escalate: true };
  return { reply: text, escalate: false };
}

export async function handleCustomerMessage(input: {
  userId: string;
  text: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ reply: string; escalate: boolean }> {
  const trimmed = input.text.trim();
  if (humanRequestPattern.test(trimmed)) {
    return { reply: "Sem problema, vou encaminhar para um atendente. Aguarde só um instante.", escalate: true };
  }
  if (trimmed === "1") return { reply: await answerPaymentStatus(input.userId), escalate: false };
  if (trimmed === "2") return { reply: await answerOrderStatus(input.userId), escalate: false };
  if (trimmed === "3") return { reply: "Sem problema, vou encaminhar para um atendente. Aguarde só um instante.", escalate: true };
  return askGroq(input.history);
}
