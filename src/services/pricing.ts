// Calculadora de preço (só admin). O servidor é quem manda: o preço do produto NUNCA vem escrito à mão, é calculado aqui.
// A mesma fórmula existe em frontend/src/lib/pricing.ts só para o ecrã mostrar o resultado enquanto se escreve — manter as duas
// em sincronia (os testes de tests/pricing.test.ts fixam os valores).
//
//   custo total   = compra × (1 + taxas%) + transporte + outros gastos
//   preço de tabela = custo total × (1 + retorno%) ÷ (1 − comissão%)      (a comissão é % do preço de venda)
//   preço ao cliente = preço de tabela × (1 − desconto%)                   (arredondado para CIMA ao metical)
//   lucro         = preço ao cliente × (1 − comissão%) − custo total
//   retorno real  = lucro ÷ custo total × 100
// O "retorno" é sobre o CUSTO TOTAL (não só sobre a compra): taxas e transporte fazem parte do que se gastou.
export interface PricingInput {
  purchaseMzn: number;
  taxPct: number;
  transportMzn: number;
  otherCostsMzn: number;
  returnPct: number;
  commissionPct: number;
  discountPct: number;
}

export interface PricingThresholds {
  /** A partir daqui o retorno é "bom" (verde). Abaixo, é baixo (vermelho). */
  goodFromPct: number;
  /** A partir daqui é "excelente". */
  excellentFromPct: number;
}

export type ProfitLevel = "loss" | "low" | "good" | "excellent";

export interface PricingResult {
  costTotal: number;
  listPrice: number;
  customerPrice: number;
  profit: number;
  returnPct: number;
  level: ProfitLevel;
}

export const DEFAULT_THRESHOLDS: PricingThresholds = { goodFromPct: 30, excellentFromPct: 80 };

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
// Arredondar primeiro a 2 casas evita que 21600.000000000004 vire 21601 por erro de vírgula flutuante.
const ceilMzn = (value: number): number => Math.ceil(round2(value));

export function levelOf(returnPct: number, thresholds: PricingThresholds = DEFAULT_THRESHOLDS): ProfitLevel {
  if (returnPct < 0) return "loss";
  if (returnPct < thresholds.goodFromPct) return "low";
  if (returnPct >= thresholds.excellentFromPct) return "excellent";
  return "good";
}

export function computePricing(input: PricingInput, thresholds: PricingThresholds = DEFAULT_THRESHOLDS): PricingResult {
  const costTotal = round2(input.purchaseMzn * (1 + input.taxPct / 100) + input.transportMzn + input.otherCostsMzn);
  const listPrice = ceilMzn((costTotal * (1 + input.returnPct / 100)) / (1 - input.commissionPct / 100));
  const customerPrice = ceilMzn(listPrice * (1 - input.discountPct / 100));
  const profit = round2(customerPrice * (1 - input.commissionPct / 100) - costTotal);
  const returnPct = costTotal > 0 ? round2((profit / costTotal) * 100) : 0;
  return { costTotal, listPrice, customerPrice, profit, returnPct, level: levelOf(returnPct, thresholds) };
}
