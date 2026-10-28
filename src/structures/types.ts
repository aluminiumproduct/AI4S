import type { Provenance } from "../dataHub";
export type Vec3 = [number, number, number];
export const MAX_STRUCTURE_BYTES = 5 * 1024 * 1024;
/** Row vectors in Å. Cartesian position = fractional position × lattice. */
export type Lattice = [Vec3, Vec3, Vec3];

export interface StructureSite {
  id: string;
  label: string;
  fractional: Vec3;
  species: { element: string; occupancy: number }[];
  sourceLabels: string[];
  selective?: [boolean, boolean, boolean];
}

/** A structure has no target-property label and is deliberately separate from Material. */
export interface CrystalStructure {
  schemaVersion: 1;
  name: string;
  lattice: Lattice;
  sites: StructureSite[];
  source: {
    filename: string;
    format: "cif" | "poscar" | "materials-project" | "data-hub";
    providerLabel?: string;
    provenance?: Provenance;
    materialId?: string;
    formula?: string;
    fetchedAt?: string;
    blockName?: string;
    coordinateMode?: "direct" | "cartesian";
    spaceGroup?: string;
    symmetry: "expanded" | "p1" | "listed-sites";
    warnings: string[];
    raw: string;
  };
}

export interface DisplayAtom {
  siteIndex: number;
  image: Vec3;
  element: string;
  position: Vec3;
}
