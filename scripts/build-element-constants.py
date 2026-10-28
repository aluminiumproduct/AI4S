"""Build the offline factual table from pinned upstream data; never used at app runtime."""
from pathlib import Path
import argparse
import ast
import gzip
import hashlib
import json
import math
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
PM_REF = "682bfd855dd89264b0ff8d6bee4815f8834cc5ac"
ASE_REF = "1435c743869c2b2eb9d511fa20129cf727a3dd64"
PM_URL = f"https://raw.githubusercontent.com/materialsproject/pymatgen/{PM_REF}/src/pymatgen/core/periodic_table.json.gz"
ASE_URL = f"https://gitlab.com/ase/ase/-/raw/{ASE_REF}/ase/data/__init__.py"

# Fixed descriptor references, not oxidation states inferred for a compound.
REFERENCE_OXIDATION = dict(zip(
    "Li Be B C N O F Na Mg Al Si P S Cl K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Rb Sr Y Zr Nb Mo Ru Rh Pd Ag Cd In Sn Sb Te I Cs Ba La Ce Pr Nd Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Th U".split(),
    [1,2,3,4,-3,-2,-1,1,2,3,4,5,-2,-1,1,2,3,4,5,3,2,3,2,2,2,2,3,4,5,-2,-1,1,2,3,4,5,6,4,3,2,1,2,3,4,5,-2,-1,1,2,3,4,3,3,3,3,3,3,3,3,3,3,3,3,4,5,6,7,4,4,4,3,2,3,2,3,4,6],
    strict=True,
))
COORDINATION = {"I":1,"II":2,"III":3,"IV":4,"V":5,"VI":6,"VII":7,"VIII":8,"IX":9,"X":10,"XI":11,"XII":12,"XIV":14}

def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()

def numeric(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None

def valence_count(z, configuration):
    if not configuration:
        return None
    orbitals = [(int(n), shell, int(count)) for n,shell,count in re.findall(r"(\d)([spdf])(\d+)", configuration)]
    if not orbitals:
        return None
    outer = max(n for n,_,_ in orbitals)
    d_block = any(lo <= z <= hi for lo,hi in [(21,30),(39,48),(72,80),(104,112)]) or z in (57,89)
    f_block = 58 <= z <= 71 or 90 <= z <= 103
    return sum(count for n,shell,count in orbitals if n == outer or (d_block and shell == 'd' and n == outer-1) or (f_block and ((shell == 'f' and n == outer-2) or (shell == 'd' and n == outer-1))))

def build(pm_bytes, ase_bytes):
    pm = json.loads(gzip.decompress(pm_bytes))
    tree = ast.parse(ase_bytes.decode())
    radii = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'covalent_radii' for t in node.targets):
            radii = [v.value if isinstance(v, ast.Constant) else None for v in node.value.args[0].elts]
    if radii is None:
        raise ValueError('Cannot find the upstream Cordero radii')
    elements = {}
    for symbol,row in sorted(pm.items(), key=lambda pair: pair[1].get('Atomic no',999) if isinstance(pair[1],dict) else 999):
        if symbol in ('D','T') or not isinstance(row,dict) or not isinstance(row.get('Atomic no'),int):
            continue
        z = row['Atomic no']
        configurations = row.get('Electronic structure')
        configuration = configurations.get('0') if isinstance(configurations,dict) else None
        ionizations = row.get('Ionization energies')
        i1 = numeric(ionizations[0]) if isinstance(ionizations,list) and ionizations else None
        affinity = numeric(row.get('Electron affinity'))
        ionic = []
        shannon = row.get('Shannon radii')
        for oxidation,coords in (shannon if isinstance(shannon,dict) else {}).items():
            if not re.fullmatch(r'-?\d+', oxidation):
                continue  # Upstream entries without an oxidation state cannot define an ionic reference.
            for coordination,spins in coords.items():
                for spin,entry in spins.items():
                    radius = numeric(entry.get('ionic_radius'))
                    if radius is not None:
                        ionic.append({'oxidationState':int(oxidation),'coordination':coordination,'coordinationNumber':COORDINATION.get(coordination),'spin':spin or 'unspecified','radiusAngstrom':radius})
        common = row.get('Common oxidation states')
        common = common if isinstance(common,list) else []
        oxidation = REFERENCE_OXIDATION.get(symbol, common[0] if len(common) == 1 else None)
        choices = [r for r in ionic if r['oxidationState'] == oxidation and r['coordination'] == 'VI']
        choices.sort(key=lambda r: {'unspecified':0,'High Spin':1,'Low Spin':2}.get(r['spin'],3))
        elements[symbol] = {
            'atomicNumber':z, 'name':row['Name'],
            'electronegativityPauling':numeric(row.get('X')),
            'covalentRadiusAngstrom':numeric(radii[z]) if z <= 96 and z < len(radii) else None,
            'neutralConfiguration':configuration,
            'valenceElectrons':valence_count(z,configuration),
            'firstIonizationEnergyEv':i1, 'electronAffinityEv':affinity,
            'chemicalHardnessEv':(i1-affinity)/2 if i1 is not None and affinity is not None else None,
            'referenceIon':choices[0] if choices else None,
            'ionicRadii':ionic,
        }
    assert len(elements) == 118
    return {
        'schemaVersion':'ai4s-elements-1.0.0',
        'provenance':{
            'pymatgen':{'version':'2025.6.14','commit':PM_REF,'url':PM_URL,'sha256':hashlib.sha256(pm_bytes).hexdigest(),'license':'MIT'},
            'ase':{'commit':ASE_REF,'url':ASE_URL,'sha256':hashlib.sha256(ase_bytes).hexdigest(),'license':'LGPL-2.1-or-later; numerical data only'},
            'covalentRadii':{'doi':'10.1039/B801115J','description':'Cordero et al. (2008), representative values as tabulated by ASE; some are interpolated. No ASE placeholder values are imported.'},
            'ionicRadii':{'doi':'10.1107/S0567739476001551','description':'Shannon effective ionic radii (ionic_radius, not crystal_radius), indexed by oxidation state, coordination and spin.'},
        },
        'conventions':{
            'radiiUnit':'angstrom', 'energyUnit':'eV',
            'hardness':'Atomic finite-difference descriptor eta=(I1-electronAffinity)/2. Not an oxide bond dissociation energy.',
            'valenceElectrons':'Neutral configuration count: outer-shell s/p for main-group; outer s plus (n-1)d for d-block; outer s plus (n-1)d and (n-2)f for f-block. This convention is not a compound oxidation state.',
            'referenceIonicRadius':'Fixed documented oxidation state, VI coordination; unspecified spin preferred, otherwise High Spin then Low Spin. Not inferred from composition or structure.',
            'missing':'null means unavailable. Values are never replaced by random numbers or ASE missing=2.0 placeholders.',
        },
        'elements':elements,
    }

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pymatgen-gz',type=Path)
    parser.add_argument('--ase-py',type=Path)
    args = parser.parse_args()
    pm_bytes = args.pymatgen_gz.read_bytes() if args.pymatgen_gz else fetch(PM_URL)
    ase_bytes = args.ase_py.read_bytes() if args.ase_py else fetch(ASE_URL)
    target = ROOT/'src/data/element-constants.json'
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(build(pm_bytes,ase_bytes),ensure_ascii=False,indent=2)+'\n')
    print(f'Built 118 elements: {target}')
