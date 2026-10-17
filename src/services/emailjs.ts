import { emailjsConfig, type EmailJsConfig } from "../config/env.js";

const ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const TIMEOUT_MS = 8_000;

export type EmailJsResult =
  | { ok: true; status: number; detail?: string }
  | { ok: false; reason: "NOT_CONFIGURED" | "REJECTED" | "NETWORK"; status?: number; detail?: string };

type Params = Record<string, string | number>;

// Envia um email pelo EmailJS a partir do SERVIDOR (REST API com a chave privada). Nunca chamar isto do browser:
// o link de recuperação contém o token e não pode passar por quem o pediu.
// Requisito na conta EmailJS: Account > Security > "Allow EmailJS API for non-browser applications".
// O `detail` devolvido é a resposta do EmailJS (ex.: "The Public Key is invalid"); nunca inclui chaves.
export async function sendEmailJs(templateId: string, params: Params, config: EmailJsConfig | null = emailjsConfig, fetchImpl: typeof fetch = fetch): Promise<EmailJsResult> {
  if (!config) return { ok: false, reason: "NOT_CONFIGURED" };
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service_id: config.serviceId,
        template_id: templateId,
        user_id: config.publicKey,
        accessToken: config.privateKey,
        template_params: params
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const responseText = (await response.text().catch(() => "")).slice(0, 200);
    if (response.ok) return { ok: true, status: response.status, detail: responseText };
    const detail = responseText;
    return { ok: false, reason: "REJECTED", status: response.status, detail };
  } catch (error) {
    return { ok: false, reason: "NETWORK", detail: error instanceof Error ? error.name : "unknown" };
  }
}
