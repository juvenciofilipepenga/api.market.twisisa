// Regras da importação em massa SEM base de dados (puras, por isso testáveis): encontrar a categoria e a característica
// que o ficheiro CSV refere pelo NOME, tal como o utilizador as escreve (maiúsculas e acentos não contam).

import { slugify } from "./catalog.js";

export interface CategoryRef { id: string; name: string; slug: string }
export interface AttributeRef { id: string; key: string; name: string }

/**
 * Categoria pedida por uma linha do CSV.
 *  - undefined: a linha não pede categoria;
 *  - null: pede, mas não existe;
 *  - categoria: a encontrada. `categoryId` (id exato) tem prioridade sobre `category` (id, slug ou nome).
 */
export function findCategory(categories: CategoryRef[], input: { categoryId?: string; category?: string }): CategoryRef | null | undefined {
  if (input.categoryId) return categories.find((c) => c.id === input.categoryId) ?? null;
  const ref = input.category?.trim();
  if (!ref) return undefined;
  const wanted = slugify(ref);
  return categories.find((c) => c.id === ref || c.slug === wanted || slugify(c.name) === wanted) ?? null;
}

/** Característica já existente na categoria com este nome (mesma chave, ou seja, "Memória RAM" = "memoria ram"). */
export function matchAttribute<A extends AttributeRef>(defs: A[], name: string): A | undefined {
  const key = slugify(name);
  if (!key) return undefined;
  return defs.find((def) => def.key === key || slugify(def.name) === key);
}
