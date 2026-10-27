import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { importStructures, MAX_STRUCTURE_BYTES } from "../src/structures/importStructure";
import { exampleCif, examplePoscar } from "../src/structures/examples";
import { cartesianToFractional, fractionalToCartesian, latticeParameters, minimumImageDistance, structureComposition } from "../src/structures/geometry";

const fixture = (name: string) => readFileSync(new URL(`./structure-fixtures/${name}`, import.meta.url), "utf8");
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test("POSCAR scalar scaling and Direct coordinates preserve physical positions and raw source", () => {
  const text = fixture("scale-direct.POSCAR");
  const [s] = importStructures(text, "POSCAR");
  assert.equal(s.sites.length, 2);
  assert.deepEqual(s.lattice, [[2, 0, 0], [0, 2, 0], [0, 0, 2]]);
  assert.deepEqual(fractionalToCartesian(s.sites[0].fractional, s.lattice), [0.5, 1, 1.5]);
  assert.equal(s.source.raw, text);
  assert.equal(s.source.coordinateMode, "direct");
  assert.ok(!("trueProperty" in s));
});

test("POSCAR Cartesian coordinates use the same universal scale", () => {
  const [s] = importStructures(fixture("scale-direct.POSCAR").replace("Direct", "Cartesian"), "test.vasp");
  assert.deepEqual(s.sites[0].fractional, [0.25, 0.5, 0.75]);
  assert.deepEqual(fractionalToCartesian(s.sites[0].fractional, s.lattice), [0.5, 1, 1.5]);
});

test("negative POSCAR scale specifies target volume and scales Cartesian positions", () => {
  const [s] = importStructures(fixture("negative-volume.POSCAR"), "POSCAR");
  close(latticeParameters(s.lattice).volume, 8);
  assert.deepEqual(s.sites[0].fractional, [0.25, 0.5, 0.75]);
});

test("POSCAR lattice validity is checked after its arbitrary-unit scale is applied", () => {
  for (const scale of ["10000", "-1"]) {
    const text = `Rescaled unit cell\n${scale}\n0.0001 0 0\n0 0.0001 0\n0 0 0.0001\nC\n1\nDirect\n0.5 0 0\n`;
    const [s] = importStructures(text, "POSCAR");
    close(latticeParameters(s.lattice).volume, 1);
    close(fractionalToCartesian(s.sites[0].fractional, s.lattice)[0], 0.5);
  }
});

test("three positive scaling factors multiply Cartesian components, not lattice rows", () => {
  const [s] = importStructures(fixture("three-scale.POSCAR"), "POSCAR");
  assert.deepEqual(s.lattice, [[2, 0, 0], [2, 3, 0], [0, 0, 4]]);
  assert.deepEqual(s.sites[0].fractional, [-0.25, 0.5, 0.75]);
  const [direct] = importStructures(fixture("three-scale.POSCAR").replace("\nCartesian\n", "\nDirect\n"), "POSCAR");
  assert.deepEqual(fractionalToCartesian(direct.sites[0].fractional, direct.lattice), [1.5, 1.5, 3]);
});

test("Selective dynamics, lowercase K and optional CONTCAR tails are handled without extra atoms", () => {
  const [s] = importStructures(fixture("selective.CONTCAR"), "CONTCAR");
  assert.deepEqual(s.sites[0].selective, [true, false, true]);
  assert.deepEqual(s.sites[1].selective, [false, false, false]);
  assert.deepEqual(s.sites[0].fractional, [0.25, 0.5, 0.75]);
  assert.equal(s.sites.length, 2);
  assert.ok(s.source.warnings.some(w => w.includes("附加段")));
});

test("VASP 4 files without species are rejected instead of guessing from the title", () => {
  const text = fixture("scale-direct.POSCAR").replace("Li O\n", "");
  assert.throws(() => importStructures(text, "POSCAR"), /VASP 4/);
});

test("invalid POSCAR counts, coordinates and cells produce explicit errors", () => {
  const text = fixture("scale-direct.POSCAR");
  for (const invalid of [text.replace("1 1\nDirect", "1\nDirect"), text.replace("0.25 0.5 0.75", "NaN 0.5 0.75"),
    text.replace("0 0 1\nLi", "0 0 0\nLi"), text.replace("1 1\nDirect", "5001 1\nDirect"), text.replace("2\n1 0 0", "0\n1 0 0")]) {
    assert.throws(() => importStructures(invalid, "POSCAR"));
  }
  assert.throws(() => importStructures(fixture("three-scale.POSCAR").replace("2 3 4", "2 -3 4"), "POSCAR"));
  assert.throws(() => importStructures(text.replace("0.25 0.5 0.75\n0 0 0", "0.25 0.5 0.75"), "POSCAR"), /坐标不足/);
  assert.throws(() => importStructures(text.replace("Direct", "Cartesian").replace("0.25 0.5 0.75", "1e308 0 0"), "POSCAR"), /有限数值范围/);
});

test("CIF uncertainties, multiline text, comments and wrapped loop rows are parsed", () => {
  const text = fixture("triclinic.cif");
  const [s] = importStructures(text, "triclinic.cif");
  assert.equal(s.sites.length, 1);
  close(s.sites[0].fractional[0], 0.123);
  const p = latticeParameters(s.lattice);
  for (const [a, b] of [[p.a, 4], [p.b, 5], [p.c, 6], [p.alpha, 70], [p.beta, 80], [p.gamma, 75]]) close(a, b);
  assert.equal(s.source.symmetry, "p1");
  assert.equal(s.source.raw, text);
});

test("CIF modern symmetry tags work even when identity is not listed first; special positions are deduplicated", () => {
  const [s] = importStructures(fixture("symmetry.cif"), "symmetry.cif");
  assert.equal(s.sites.length, 3);
  assert.deepEqual(structureComposition(s), { O: 1, Fe: 2 });
  assert.equal(s.source.symmetry, "expanded");
  assert.ok(s.sites.some(site => Math.abs(site.fractional[0] - 0.9) < 1e-8));
});

test("CIF old symmetry tag and fractional translations produce an eight-site NaCl cell", () => {
  const [s] = importStructures(exampleCif.replace("_space_group_symop_operation_xyz", "_symmetry_equiv_pos_as_xyz"), "NaCl.cif");
  assert.equal(s.sites.length, 8);
  assert.deepEqual(structureComposition(s), { Na: 4, Cl: 4 });
  assert.equal(new Set(s.sites.map(site => site.fractional.join(","))).size, 8);
});

test("CIF metadata-only blocks are skipped and mixed occupancy is preserved across multiple structures", () => {
  const data = importStructures(fixture("mixed-multiblock.cif"), "mixed.cif");
  assert.deepEqual(data.map(s => s.name), ["mixed", "partial"]);
  assert.equal(data[0].sites.length, 1);
  assert.deepEqual(structureComposition(data[0]), { Fe: 0.5, Co: 0.5 });
  assert.deepEqual(data[0].sites[0].sourceLabels, ["Fe1", "Co1"]);
  assert.deepEqual(structureComposition(data[1]), { O: 0.25 });
  assert.ok(data[0].source.warnings.some(w => w.includes("混占")));
});

test("unknown symmetry is not silently treated as a completed unit cell", () => {
  const text = fixture("triclinic.cif").replace("'P 1'", "'P n m a'");
  const [s] = importStructures(text, "unknown-symmetry.cif");
  assert.equal(s.source.symmetry, "listed-sites");
  assert.ok(s.source.warnings.some(w => w.includes("未提供对称操作")));
});

test("Cartesian CIF coordinates convert using the full triclinic lattice", () => {
  const text = fixture("triclinic.cif").replaceAll("_atom_site_fract_", "_atom_site_Cartn_");
  const [s] = importStructures(text, "cartesian.cif");
  const originalFrac = cartesianToFractional([0.123, 0.25, 0.75], s.lattice);
  // CIF symmetry normalization may wrap a Cartesian point into an equivalent periodic image.
  close(minimumImageDistance(originalFrac, s.sites[0].fractional, s.lattice), 0);
});

test("Cartesian CIF applies its explicit orientation and origin before fractional conversion", () => {
  const [s] = importStructures(fixture("cartesian-transform.cif"), "transformed.cif");
  // A 90-degree orientation of a=4, b=5, c=6 with origin (1,2,3).
  // The second point is at 0.9 a, so its periodic separation is 0.1 a = 0.4 A.
  close(s.sites[1].fractional[0], 0.9);
  close(s.sites[1].fractional[1], 0);
  close(minimumImageDistance(s.sites[0].fractional, s.sites[1].fractional, s.lattice), 0.4);
  const text = fixture("cartesian-transform.cif");
  assert.throws(() => importStructures(text.replace("_atom_sites_Cartn_tran_matrix_33 6", ""), "bad.cif"), /不完整/);
  assert.throws(() => importStructures(text.replace("_atom_sites_Cartn_tran_matrix_33 6", "_atom_sites_Cartn_tran_matrix_33 7"), "bad.cif"), /不一致/);
});

test("CIF symmetry must preserve the metric rather than merely having determinant one", () => {
  const text = exampleCif.replace("'x,y+1/2,z+1/2'", "'x+y,y,z'");
  assert.throws(() => importStructures(text, "shear.cif"), /晶格度量/);
});

test("symmetry-equivalent same-element partial occupancies are not silently added", () => {
  const text = `data_partial\n_cell_length_a 5\n_cell_length_b 5\n_cell_length_c 5\n_cell_angle_alpha 90\n_cell_angle_beta 90\n_cell_angle_gamma 90\nloop_\n_space_group_symop_operation_xyz\n'x,y,z'\n'-x,-y,-z'\nloop_\n_atom_site_label\n_atom_site_type_symbol\n_atom_site_fract_x\n_atom_site_fract_y\n_atom_site_fract_z\n_atom_site_occupancy\nC1 C .1 .2 .3 .5\nC2 C .9 .8 .7 .5\n`;
  assert.throws(() => importStructures(text, "ambiguous.cif"), /避免错误累加占位/);
});

test("missing numbers, over-occupancy, unknown elements and executable symmetry text are rejected", () => {
  const text = fixture("triclinic.cif");
  assert.throws(() => importStructures(text.replace("4.0(2)", "?"), "invalid.cif"));
  assert.throws(() => importStructures(text.replace("C1 C", "C1 Foo"), "invalid.cif"), /元素/);
  assert.throws(() => importStructures(fixture("mixed-multiblock.cif").replaceAll("0.5", "0.8"), "invalid.cif"), /超过 1/);
  assert.throws(() => importStructures(fixture("symmetry.cif").replace("'-x,-y,-z'", "'globalThis.alert(1),y,z'"), "invalid.cif"));
});

test("empty, binary, oversized and explicitly unsupported CIF features are rejected", () => {
  for (const text of ["", "\0abc", "x".repeat(MAX_STRUCTURE_BYTES + 1)]) assert.throws(() => importStructures(text, "test.cif"));
  assert.throws(() => importStructures("#\\#CIF_2.0\n" + exampleCif, "test.cif"), /CIF 2.0/);
  assert.throws(() => importStructures(exampleCif + "\nsave_test\n", "test.cif"), /save frames/);
});

test("ideal demonstration POSCAR remains a five-site structure without a fabricated label", () => {
  const [s] = importStructures(examplePoscar, "demo.POSCAR");
  assert.deepEqual(structureComposition(s), { Sr: 1, Ti: 1, O: 3 });
  assert.equal(s.sites.length, 5);
  assert.ok(!("band_gap" in s) && !("trueProperty" in s));
});
