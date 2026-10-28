"""JSON-in/JSON-out powder diffraction and spectrum comparison for the AI4S demo."""
import json
import sys
import warnings

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.optimize import nnls
from scipy.signal import find_peaks
from pymatgen.core import Lattice, Structure
from pymatgen.analysis.diffraction.xrd import XRDCalculator

warnings.filterwarnings("ignore", category=UserWarning)


def decode_structure(data):
    sites = data["sites"]
    if not 1 <= len(sites) <= 1200:
        raise ValueError("XRD 演示支持 1–1200 个晶胞位点")
    species = [{row["element"]: row["occupancy"] for row in site["species"]} for site in sites]
    return Structure(Lattice(data["lattice"]), species, [site["fractional"] for site in sites])


def reference_structures(elements):
    phases = []
    if "Ti" in elements:
        phases.append(("TiO₂ · rutile", Structure.from_spacegroup(
            "P4_2/mnm", Lattice.tetragonal(4.594, 2.959), ["Ti", "O"], [[0, 0, 0], [.305, .305, 0]])))
    for element, lattice in [("Sr", 5.16), ("Ba", 5.54), ("Mg", 4.212), ("Ca", 4.81), ("Co", 4.26), ("Ni", 4.177)]:
        if element in elements:
            phases.append((element + "O", Structure.from_spacegroup(
                "Fm-3m", Lattice.cubic(lattice), [element, "O"], [[0, 0, 0], [.5, .5, .5]])))
    if "Zr" in elements:
        phases.append(("c-ZrO₂", Structure.from_spacegroup(
            "Fm-3m", Lattice.cubic(5.09), ["Zr", "O"], [[0, 0, 0], [.25, .25, .25]])))
    if "Li" in elements:
        phases.append(("Li₂O", Structure.from_spacegroup(
            "Fm-3m", Lattice.cubic(4.619), ["O", "Li"], [[0, 0, 0], [.25, .25, .25]])))
    if "Zn" in elements:
        phases.append(("ZnO", Structure.from_spacegroup(
            "P6_3mc", Lattice.hexagonal(3.249, 5.206), ["Zn", "O"], [[1/3, 2/3, 0], [1/3, 2/3, .3825]])))
    if not phases:
        phases.append(("Si · 内标参照", Structure.from_spacegroup(
            "Fd-3m", Lattice.cubic(5.431), ["Si"], [[0, 0, 0]])))
    return phases[:3]


def broaden(peaks, grid, fwhm):
    y = np.zeros_like(grid)
    for peak in peaks:
        delta = (grid - peak["twoTheta"]) / fwhm
        y += peak["intensity"] * (.65 * np.exp(-4 * np.log(2) * delta**2) + .35 / (1 + 4 * delta**2))
    return y


def points(grid, intensity):
    return [{"twoTheta": round(float(x), 4), "intensity": round(float(y), 6)} for x, y in zip(grid, intensity)]


def calculate_pattern(structure, name, options):
    wavelength = options.get("wavelength", "CuKa")
    lo, hi = float(options.get("min", 10)), float(options.get("max", 80))
    fwhm = float(options.get("fwhm", .16))
    if not 0 <= lo < hi <= 160 or hi - lo < 1 or not .03 <= fwhm <= 1.5:
        raise ValueError("请检查衍射角范围与峰宽")
    calculated = XRDCalculator(wavelength=wavelength, symprec=0).get_pattern(structure, two_theta_range=(lo, hi))
    peaks = [{"twoTheta": float(x), "intensity": float(y),
              "hkl": " / ".join("(" + " ".join(map(str, row["hkl"])) + ")" for row in hkls),
              "d": float(d)} for x, y, hkls, d in zip(calculated.x, calculated.y, calculated.hkls, calculated.d_hkls)]
    grid = np.arange(lo, hi + .0201, .04)
    return {"name": name, "peaks": peaks, "profile": points(grid, broaden(peaks, grid, fwhm)),
            "wavelength": wavelength, "min": lo, "max": hi, "fwhm": fwhm}


def xrd(payload):
    structure = decode_structure(payload["structure"])
    options = payload.get("options", {})
    name = payload["structure"].get("name") or structure.composition.reduced_formula
    pattern = calculate_pattern(structure, name, options)
    references = [calculate_pattern(candidate, label, options)
                  for label, candidate in reference_structures({el.symbol for el in structure.composition.elements})
                  if candidate.composition.reduced_formula != structure.composition.reduced_formula]
    if not references:
        references = [calculate_pattern(candidate, label, options) for label, candidate in reference_structures(set())]
    return {"pattern": pattern, "references": references, "engine": "pymatgen XRDCalculator 2025.6.14"}


def demo(payload):
    pattern = payload["pattern"]
    references = payload.get("references", [])
    grid = np.array([row["twoTheta"] for row in pattern["profile"]])
    target = np.array([row["intensity"] for row in pattern["profile"]])
    fraction = .65 if payload.get("kind") == "impurity" else .984
    impurity = np.zeros_like(target) if not references else np.interp(
        grid, [row["twoTheta"] for row in references[0]["profile"]], [row["intensity"] for row in references[0]["profile"]])
    rng = np.random.default_rng(42)
    y = 2400 * (fraction * target + (1-fraction) * impurity) + 350 + 3 * (grid-grid[0]) + rng.normal(0, 7, len(grid))
    # A known small specimen/zero offset gives the alignment control real work to do.
    return {"points": points(grid + .04, y), "filename": "demo-impurity.xy" if fraction < .9 else "demo-single-phase.xy",
            "demo": True, "nominalMainFraction": fraction * 100}


def compare(payload):
    rows = payload["points"]
    if not 8 <= len(rows) <= 100000:
        raise ValueError("谱图需要 8–100000 个数据点")
    measured_x = np.array([row["twoTheta"] for row in rows], dtype=float)
    measured_y = np.array([row["intensity"] for row in rows], dtype=float)
    if not np.isfinite(measured_x).all() or not np.isfinite(measured_y).all():
        raise ValueError("谱图包含无效数值")
    order = np.argsort(measured_x)
    measured_x, measured_y = measured_x[order], measured_y[order]
    patterns = [payload["pattern"], *payload.get("references", [])]
    profile = patterns[0]["profile"]
    grid = np.array([row["twoTheta"] for row in profile])
    mask = (grid >= measured_x.min()) & (grid <= measured_x.max())
    grid = grid[mask]
    if len(grid) < 20:
        raise ValueError("实验谱与模拟谱的角度范围没有足够重叠")
    observed = np.interp(grid, measured_x, measured_y)
    amplitude = float(np.ptp(observed))
    if amplitude <= 1e-9:
        raise ValueError("谱图没有可分析的强度变化")
    observed = (observed - observed.min()) / amplitude * 100
    background = (grid-grid.min()) / max(float(np.ptp(grid)), 1)
    best = None
    for shift in np.arange(-.25, .2501, .01):
        columns = [np.interp(grid-shift, [p["twoTheta"] for p in pattern["profile"]],
                             [p["intensity"] for p in pattern["profile"]], left=0, right=0) for pattern in patterns]
        design = np.column_stack([*columns, np.ones(len(grid)), background])
        coefficients, error = nnls(design, observed)
        if best is None or error < best[0]:
            best = error, float(shift), design @ coefficients, coefficients, design
    error, shift, fitted, coefficients, design = best
    phase_coefficients = coefficients[:len(patterns)]
    total = float(phase_coefficients.sum())
    fractions = phase_coefficients / total * 100 if total > 0 else np.zeros(len(patterns))
    smooth = gaussian_filter1d(observed, 1)
    indices, _ = find_peaks(smooth, prominence=2, distance=3)
    experimental_peaks = points(grid[indices], smooth[indices])
    theoretical = [p for p in patterns[0]["peaks"] if p["intensity"] >= 4 and grid.min() <= p["twoTheta"]+shift <= grid.max()]
    tolerance = max(.16, patterns[0]["fwhm"] * 1.5)
    matched = sum(any(abs(p["twoTheta"]+shift-grid[i]) <= tolerance for i in indices) for p in theoretical)
    coverage = matched / len(theoretical) * 100 if theoretical else 0
    unmatched = [p for p in experimental_peaks if not any(abs(p["twoTheta"]-q["twoTheta"]-shift) <= tolerance for q in patterns[0]["peaks"])]
    residual = observed-fitted
    target_design = design[:, [0, -2, -1]]
    target_coefficients, _ = nnls(target_design, observed)
    target_residual = observed-target_design @ target_coefficients
    target_r_squared = max(0, 1-float(np.sum(target_residual**2))/max(float(np.sum((observed-observed.mean())**2)), 1e-9))
    score = min(100, max(0, 100*(.7*target_r_squared + .3*coverage/100)))
    main = float(fractions[0])
    return {"score": round(score, 2), "mainFraction": round(main, 2), "passed": bool(main >= 90 and score >= 80),
            "shift": round(shift, 3), "rmse": round(float(np.sqrt(np.mean(residual**2))), 4),
            "peakCoverage": round(coverage, 2),
            "phases": [{"name": p["name"], "percent": round(float(f), 2), "target": i == 0} for i, (p, f) in enumerate(zip(patterns, fractions))],
            "experimentalPeaks": experimental_peaks, "unmatchedPeaks": unmatched,
            "observed": points(grid, observed), "fitted": points(grid, fitted), "residual": points(grid, residual)}


if __name__ == "__main__":
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = {"xrd": xrd, "compare": compare, "demo": demo}[request["operation"]](request)
            print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
        except Exception as error:
            print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
