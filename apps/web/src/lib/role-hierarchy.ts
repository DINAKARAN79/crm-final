export interface RoleHierarchyItem {
  id: string;
  name: string;
  parentRoleId?: string | null;
}

export interface RoleHierarchyOption extends RoleHierarchyItem {
  depth: number;
}

export function buildRoleHierarchyOptions(roles: RoleHierarchyItem[]): RoleHierarchyOption[] {
  const roleIds = new Set(roles.map((role) => role.id));
  const childrenByParent = new Map<string | null, RoleHierarchyItem[]>();

  for (const role of roles) {
    const parentId = role.parentRoleId && roleIds.has(role.parentRoleId) ? role.parentRoleId : null;
    const children = childrenByParent.get(parentId) || [];
    children.push(role);
    childrenByParent.set(parentId, children);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name));
  }

  const options: RoleHierarchyOption[] = [];
  const visited = new Set<string>();
  const visit = (role: RoleHierarchyItem, depth: number) => {
    if (visited.has(role.id)) return;
    visited.add(role.id);
    options.push({ ...role, depth });
    for (const child of childrenByParent.get(role.id) || []) visit(child, depth + 1);
  };

  for (const root of childrenByParent.get(null) || []) visit(root, 0);

  // Keep malformed cyclic data visible rather than silently hiding roles.
  for (const role of [...roles].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!visited.has(role.id)) visit(role, 0);
  }

  return options;
}
