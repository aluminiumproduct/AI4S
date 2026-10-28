# Offline elemental reference data

`element-constants.json` contains factual numerical data transformed by
`scripts/build-element-constants.py`; no upstream executable code is bundled.
The JSON records upstream commit IDs, input SHA-256 hashes, units, missing values,
and reference-state conventions. It is loaded locally; no API key is needed.

## Sources

- pymatgen 2025.6.14, commit `682bfd855dd89264b0ff8d6bee4815f8834cc5ac`,
  `src/pymatgen/core/periodic_table.json.gz`. Pauling electronegativity,
  neutral electronic configurations, first ionization energies, electron
  affinities and the Shannon radii transcription. MIT notice:
  [licenses/pymatgen-MIT.txt](licenses/pymatgen-MIT.txt).
- ASE, commit `1435c743869c2b2eb9d511fa20129cf727a3dd64`,
  `ase/data/__init__.py`, covalent radius numerical table. LGPL-2.1-or-later
  notice: [licenses/ASE-LGPL.txt](licenses/ASE-LGPL.txt).
- B. Cordero et al., *Covalent radii revisited*, Dalton Trans. (2008), 2832–2838,
  DOI: https://doi.org/10.1039/B801115J. Representative values in Å as tabulated
  by ASE; some values are interpolated and are not universal bond lengths.
  ASE's `missing=2.0` placeholders are never imported.
- R. D. Shannon, *Revised effective ionic radii and systematic studies of
  interatomic distances in halides and chalcogenides*, Acta Cryst. A32 (1976),
  751–767, DOI: https://doi.org/10.1107/S0567739476001551. We use `ionic_radius`,
  not `crystal_radius`, retaining oxidation state, coordination label and spin.
  Upstream entries lacking an oxidation state are excluded.

Chemical hardness is explicitly **derived** as `(I1 - electronAffinity)/2` from
the pinned atom data, in eV; it is not an oxide bond dissociation energy.
For the hardness definition, see R. G. Parr and R. G. Pearson, *Absolute hardness:
companion parameter to absolute electronegativity*, JACS 105 (1983), 7512–7516,
DOI: https://doi.org/10.1021/ja00364a005. The atom values themselves come from
the pinned pymatgen table, rather than being claimed as a fresh measurement.
Valence counts use the stated neutral-configuration convention, including d/f
electrons for d/f-block elements; they are not compound oxidation states.
Missing values remain `null`. A fixed ionic reference does not establish an
ion's actual charge or coordination in a material.

Goldschmidt t is available only under a charge-balanced, unambiguous ABO3
reference-site model with matching Shannon A(CN12), B(CN6), O(-2,CN6) radii.
Composition alone cannot identify a perovskite structure or distinguish
polymorphs. Dataset and feature schema versions must travel with predictions.
