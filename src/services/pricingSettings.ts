import { prisma } from "../lib/prisma.js";
import type { PricingThresholds } from "./pricing.js";

export async function getPricingThresholds(): Promise<PricingThresholds> {
  const row = await prisma.pricingSettings.upsert({ where: { id: "main" }, update: {}, create: { id: "main" } });
  return { goodFromPct: Number(row.goodFromPct), excellentFromPct: Number(row.excellentFromPct) };
}
