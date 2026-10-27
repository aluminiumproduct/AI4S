import assert from "node:assert/strict";
import test from "node:test";
import { cellEdges, displayAtoms, fractionalToCartesian, cartesianToFractional, latticeFromParameters, minimumImageDistance } from "../src/structures/geometry";
import { importStructures } from "../src/structures/importStructure";
import { examplePoscar } from "../src/structures/examples";
import type { Lattice, Vec3 } from "../src/structures/types";

test("fractional and Cartesian positions round-trip through a triclinic cell", () => {
  const cell = latticeFromParameters(4, 5, 6, 70, 80, 75);
  for (const frac of [[0, 0, 0], [0.2, 0.6, 0.9], [-1.2, 2.4, 0.1]] as Vec3[]) {
    const restored = cartesianToFractional(fractionalToCartesian(frac, cell), cell);
    restored.forEach((value, i) => assert.ok(Math.abs(value - frac[i]) < 1e-10));
  }
});

test("minimum periodic distance crosses unit-cell boundaries", () => {
  const cell: Lattice = [[5, 0, 0], [0, 5, 0], [0, 0, 5]];
  assert.ok(Math.abs(minimumImageDistance([0.98, 0, 0], [0.02, 0, 0], cell) - 0.2) < 1e-10);
});

test("skew cells use lattice image search rather than component-wise rounding", () => {
  const cell: Lattice = [[1, 0, 0], [0.9, 0.5, 0], [0, 0, 1]];
  const expected = Math.hypot(-0.069, 0.245);
  assert.ok(Math.abs(minimumImageDistance([0, 0, 0], [0.49, 0.49, 0], cell) - expected) < 1e-10);
});

test("display supercells replicate sites without mutating scientific structure data", () => {
  const [s] = importStructures(examplePoscar, "POSCAR");
  const original = JSON.stringify(s);
  assert.equal(displayAtoms(s, 1).length, 5);
  const supercell = displayAtoms(s, 2);
  assert.equal(supercell.length, 40);
  assert.equal(new Set(supercell.map(a => `${a.siteIndex}:${a.image.join(",")}`)).size, 40);
  assert.equal(JSON.stringify(s), original);
  assert.equal(cellEdges(s.lattice).length, 12);
  assert.equal(cellEdges(s.lattice, 2).length, 12);
  assert.throws(() => displayAtoms(s, 3));
});
