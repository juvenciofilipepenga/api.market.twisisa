// Permissões e perfis de administração. Vivem no código (não na base de dados) para que um erro de dados nunca dê
// permissões a mais; na base de dados fica só QUAIS perfis cada administrador tem (User.adminProfiles).
//
// SUPER_ADMIN tem todas as permissões. ADMIN tem a união das permissões dos seus perfis (sem perfis, não tem nenhuma).
// A API é quem decide; esconder menus no frontend é só conforto.

export const PERMISSIONS = [
  "dashboard.view",
  "orders.view",
  "orders.manage",
  "payments.view",
  "payments.manage",
  "finance.settings",
  "catalog.products",
  "catalog.categories",
  "support.manage",
  "users.view",
  "users.manage",
  "blog.manage",
  "team.manage"
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ADMIN_PROFILES = ["ORDERS", "FINANCE", "CATALOG", "SUPPORT", "CONTENT"] as const;
export type AdminProfileName = (typeof ADMIN_PROFILES)[number];

export const PROFILE_PERMISSIONS: Record<AdminProfileName, readonly Permission[]> = {
  ORDERS: ["dashboard.view", "orders.view", "orders.manage", "payments.view", "users.view"],
  FINANCE: ["dashboard.view", "orders.view", "payments.view", "payments.manage", "finance.settings", "users.view"],
  CATALOG: ["catalog.products", "catalog.categories"],
  SUPPORT: ["support.manage", "orders.view", "users.view", "users.manage"],
  CONTENT: ["blog.manage"]
};

export function isAdminProfile(value: string): value is AdminProfileName {
  return (ADMIN_PROFILES as readonly string[]).includes(value);
}

export function permissionsFor(roles: readonly string[], profiles: readonly string[]): Permission[] {
  if (roles.includes("SUPER_ADMIN")) return [...PERMISSIONS];
  if (!roles.includes("ADMIN")) return [];
  const granted = new Set<Permission>();
  for (const profile of profiles) {
    if (!isAdminProfile(profile)) continue;
    for (const permission of PROFILE_PERMISSIONS[profile]) granted.add(permission);
  }
  return PERMISSIONS.filter((permission) => granted.has(permission));
}

/** Perfis que dão QUALQUER uma destas permissões (para saber a quem notificar). */
export function profilesWith(permissions: readonly Permission[]): AdminProfileName[] {
  return ADMIN_PROFILES.filter((profile) => PROFILE_PERMISSIONS[profile].some((permission) => permissions.includes(permission)));
}
