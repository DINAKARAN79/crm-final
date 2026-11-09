import { describe, expect, it } from "vitest";
import { buildRoleHierarchyOptions } from "./role-hierarchy";

describe("buildRoleHierarchyOptions", () => {
  it("nests and sorts tenant roles by their parent-child relationships", () => {
    expect(buildRoleHierarchyOptions([
      { id: "seller", name: "Seller", parentRoleId: "sales" },
      { id: "admin", name: "Admin" },
      { id: "senior", name: "Senior Seller", parentRoleId: "seller" },
      { id: "sales", name: "Sales" },
    ]).map(({ id, depth }) => [id, depth])).toEqual([
      ["admin", 0],
      ["sales", 0],
      ["seller", 1],
      ["senior", 2],
    ]);
  });

  it("keeps every role visible if the stored hierarchy contains a cycle", () => {
    expect(buildRoleHierarchyOptions([
      { id: "a", name: "A", parentRoleId: "b" },
      { id: "b", name: "B", parentRoleId: "a" },
    ])).toHaveLength(2);
  });
});
