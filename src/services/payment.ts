// Fluxo MANUAL (legado): o cliente paga fora (ex.: transferência/POS) e submete um comprovativo que o admin revê.
// O fluxo online (M-Pesa, e-Mola, cartão) vive em services/zumbopay.ts + services/paymentFlow.ts.
export type PaymentCreateInput = {
  amountMzn: number;
  method: string;
  customerPhone?: string;
  reference: string;
};

export type PaymentCreateResult = {
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

export function getPaymentProvider(_provider: "MANUAL"): PaymentProvider {
  return new ManualPaymentProvider();
}
