// Regras do catálogo SEM base de dados (puras, por isso testáveis): opções de variante, chave canónica, preço efetivo,
// stock disponível, valores de características e validação de uma linha de encomenda.

export type VariantOptions = Record<string, string>;
export const COLOR_OPTION = "Cor";
export const SIZE_OPTION = "Tamanho";
export const MAX_OPTIONS = 6;
const HEX = /^#[0-9a-fA-F]{6}$/;

export class CatalogError extends Error {
  constructor(public readonly code: string, public readonly detail?: string) {
    super(code);
  }
}

export const slugify = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Limpa nomes e valores (espaços, vazios) e limita o número de opções. */
export function normalizeOptions(raw: Record<string, string> | null | undefined): VariantOptions {
  const out: VariantOptions = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const n = name.trim();
    const v = String(value ?? "").trim();
    if (n && v) out[n] = v;
  }
  if (Object.keys(out).length > MAX_OPTIONS) throw new CatalogError("TOO_MANY_OPTIONS");
  return out;
}

/**
 * Chave canónica: nomes em minúsculas por ordem alfabética, "nome=valor" separados por "|", tudo em minúsculas.
 * TEM de coincidir com a que a migração 012 calculou para as variantes antigas (ex.: "cor=#000000|tamanho=m").
 */
export function optionKeyOf(options: VariantOptions): string {
  return Object.entries(options)
    .map(([name, value]) => [name.trim().toLowerCase(), value.trim().toLowerCase()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
}

export function optionsFromLegacy(colorHex?: string | null, size?: string | null): VariantOptions {
  const out: VariantOptions = {};
  if (colorHex) out[COLOR_OPTION] = colorHex;
  if (size) out[SIZE_OPTION] = size;
  return out;
}

/** As colunas antigas (colorHex/size) continuam a ser preenchidas, para o resto da aplicação e para encomendas antigas. */
export function legacyFromOptions(options: VariantOptions): { colorHex: string | null; size: string | null } {
  const find = (wanted: string) => Object.entries(options).find(([name]) => name.trim().toLowerCase() === wanted.toLowerCase())?.[1];
  const color = find(COLOR_OPTION);
  const size = find(SIZE_OPTION);
  return { colorHex: color && HEX.test(color) ? color : null, size: size ?? null };
}

/** Texto da variante guardado na encomenda: "Cor: #000000 · Tamanho: M". */
export function variantLabel(options: VariantOptions): string {
  return Object.entries(options).map(([name, value]) => `${name}: ${value}`).join(" · ");
}

export interface VariantInput {
  colorHex?: string | null;
  size?: string | null;
  options?: Record<string, string> | null;
  sku?: string | null;
  priceMzn?: number | null;
  stock: number;
  active?: boolean;
}

export interface NormalizedVariant {
  options: VariantOptions;
  optionKey: string;
  colorHex: string | null;
  size: string | null;
  sku: string | null;
  priceMzn: number | null;
  stock: number;
  active: boolean;
}

/** Aceita o formato novo (options) e o antigo (colorHex/size). Rejeita variantes sem opções e combinações/SKUs repetidos. */
export function normalizeVariants(inputs: VariantInput[]): NormalizedVariant[] {
  const seenKeys = new Set<string>();
  const seenSkus = new Set<string>();
  return inputs.map((input) => {
    const options = normalizeOptions(input.options ?? optionsFromLegacy(input.colorHex, input.size));
    if (Object.keys(options).length === 0) throw new CatalogError("VARIANT_ATTRIBUTE_REQUIRED");
    const optionKey = optionKeyOf(options);
    if (seenKeys.has(optionKey)) throw new CatalogError("DUPLICATE_VARIANT");
    seenKeys.add(optionKey);
    const sku = input.sku?.trim() ? input.sku.trim() : null;
    if (sku) {
      const lower = sku.toLowerCase();
      if (seenSkus.has(lower)) throw new CatalogError("DUPLICATE_SKU");
      seenSkus.add(lower);
    }
    return { options, optionKey, ...legacyFromOptions(options), sku, priceMzn: input.priceMzn ?? null, stock: input.stock, active: input.active ?? true };
  });
}

/** Fonte de verdade do preço: o da variante, se tiver; senão o do produto. */
export function effectivePrice<T>(productPrice: T, variantPrice: T | null | undefined): T {
  return variantPrice ?? productPrice;
}

/** Fonte de verdade do stock: com variantes ativas, a soma das variantes; sem variantes, o do produto. */
export function availableStock(product: { stock: number; variants?: Array<{ stock: number; active?: boolean }> }): number {
  const active = (product.variants ?? []).filter((v) => v.active !== false);
  return active.length > 0 ? active.reduce((sum, v) => sum + Math.max(0, v.stock), 0) : product.stock;
}

export interface OptionDef { name: string; kind: "COLOR" | "TEXT"; values: string[] }

/** Opções que o cliente pode escolher, deduzidas das variantes reais (só existe o que se vende). */
export function describeOptions(variants: Array<{ options: VariantOptions; active?: boolean }>): OptionDef[] {
  const defs = new Map<string, string[]>();
  for (const variant of variants.filter((v) => v.active !== false)) {
    for (const [name, value] of Object.entries(variant.options)) {
      const list = defs.get(name) ?? [];
      if (!list.includes(value)) list.push(value);
      defs.set(name, list);
    }
  }
  return [...defs.entries()].map(([name, values]) => ({ name, kind: values.every((v) => HEX.test(v)) ? "COLOR" : "TEXT", values }));
}

// ── Características por categoria ────────────────────────────────────────────────────────────────────────────────────
export type AttributeType = "TEXT" | "NUMBER" | "BOOLEAN" | "SELECT" | "MEASURE";
export interface AttributeDef { id: string; name: string; type: string; options: unknown; required: boolean }
export interface ParsedValue { valueText: string | null; valueNumber: number | null; valueBool: boolean | null }

const EMPTY: ParsedValue = { valueText: null, valueNumber: null, valueBool: null };

/** Converte o valor recebido para a coluna certa do tipo. null/"" = sem valor. */
export function parseAttributeValue(def: AttributeDef, raw: string | number | boolean | null | undefined): ParsedValue | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const bad = () => new CatalogError("ATTRIBUTE_INVALID_VALUE", def.name);
  switch (def.type) {
    case "TEXT": {
      const text = String(raw).trim();
      if (!text || text.length > 300) throw bad();
      return { ...EMPTY, valueText: text };
    }
    case "NUMBER":
    case "MEASURE": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw bad();
      return { ...EMPTY, valueNumber: n };
    }
    case "BOOLEAN": {
      if (typeof raw === "boolean") return { ...EMPTY, valueBool: raw };
      if (raw === "true" || raw === "false") return { ...EMPTY, valueBool: raw === "true" };
      throw bad();
    }
    case "SELECT": {
      const options = Array.isArray(def.options) ? (def.options as unknown[]).map(String) : [];
      const text = String(raw).trim();
      if (!options.includes(text)) throw bad();
      return { ...EMPTY, valueText: text };
    }
    default:
      throw bad();
  }
}

// ── Linha de encomenda ───────────────────────────────────────────────────────────────────────────────────────────────
export interface OrderableVariant { id: string; active: boolean; stock: number; priceMzn: unknown | null; sku: string | null; options: unknown; colorHex: string | null; size: string | null }
export interface OrderableProduct<P> { id: string; name: string; priceMzn: P; stock: number; variants: Array<OrderableVariant & { priceMzn: P | null }> }

/**
 * Decide, no servidor, o que se vende e a que preço. Nunca usa preço, stock ou total vindos do frontend.
 * Erros: VARIANT_NOT_FOUND (variante pedida não existe/inativa ou produto sem variantes), VARIANT_REQUIRED (produto com
 * variantes e nenhuma escolhida), INSUFFICIENT_STOCK.
 */
export function resolveOrderLine<P>(product: OrderableProduct<P>, request: { variantId?: string | null; quantity: number }) {
  const active = product.variants.filter((v) => v.active);
  const variant = request.variantId ? active.find((v) => v.id === request.variantId) : undefined;
  if (request.variantId && !variant) throw new CatalogError("VARIANT_NOT_FOUND");
  if (active.length > 0 && !variant) throw new CatalogError("VARIANT_REQUIRED");
  const available = variant ? variant.stock : product.stock;
  if (available < request.quantity) throw new CatalogError("INSUFFICIENT_STOCK");
  // Variante antiga (options vazio) cai para colorHex/size, para o texto da encomenda nunca ficar em branco.
  const stored = variant ? normalizeOptions((variant.options as VariantOptions | null) ?? {}) : {};
  const options = variant ? (Object.keys(stored).length ? stored : optionsFromLegacy(variant.colorHex, variant.size)) : {};
  return {
    variant,
    unitPrice: effectivePrice<P>(product.priceMzn, variant?.priceMzn ?? null),
    label: variant ? variantLabel(options) : null,
    sku: variant?.sku ?? null
  };
}
