import { env, zumboPayConfigured } from "../config/env.js";

export type PaymentCreateInput = {
  amountMzn: number;
  method: string;
  customerPhone?: string;
  reference: string;
  returnUrl?: string;
  webhookUrl?: string;
};

export type PaymentCreateResult = {
  providerPaymentId?: string;
  checkoutUrl?: string;
  status: "INITIATED" | "PENDING_CONFIRMATION";
};

export interface PaymentProvider {
  createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult>;
}

class ManualPaymentProvider implements PaymentProvider {
  async createPayment(): Promise<PaymentCreateResult> {
    return { status: "PENDING_CONFIRMATION" };
  }
}

class ZumboPayProvider implements PaymentProvider {
  async createPayment(input: PaymentCreateInput): Promise<PaymentCreateResult> {
    if (!zumboPayConfigured || !env.ZUMBOPAY_API_BASE_URL || !env.ZUMBOPAY_API_KEY) {
      throw new Error("ZUMBOPAY_NOT_CONFIGURED");
    }
    const url = new URL(env.ZUMBOPAY_PAYMENT_PATH, env.ZUMBOPAY_API_BASE_URL).toString();
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${env.ZUMBOPAY_API_KEY}`,
        "Content-Type": "application/json",
        ...(env.ZUMBOPAY_MERCHANT_ID ? { "X-Merchant-Id": env.ZUMBOPAY_MERCHANT_ID } : {})
      },
      body: JSON.stringify({
        amount: input.amountMzn,
        currency: "MZN",
        method: input.method,
        reference: input.reference,
        customer: input.customerPhone ? { phone: input.customerPhone } : undefined,
        return_url: input.returnUrl,
        callback_url: input.webhookUrl
      })
    });
    if (!response.ok) throw new Error(`ZUMBOPAY_HTTP_${response.status}`);
    const body = await response.json() as Record<string, unknown>;
    return {
      providerPaymentId: typeof body.id === "string" ? body.id : undefined,
      checkoutUrl: typeof body.checkout_url === "string" ? body.checkout_url : undefined,
      status: "INITIATED"
    };
  }
}

export function getPaymentProvider(provider: "MANUAL" | "ZUMBOPAY"): PaymentProvider {
  return provider === "ZUMBOPAY" ? new ZumboPayProvider() : new ManualPaymentProvider();
}
