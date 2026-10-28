"""Persistent, CPU-only MACE/ASE relaxation worker. stdout is JSONL; logs go to stderr."""
import argparse
import contextlib
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import time
from datetime import datetime, timezone

PROTOCOL_STDOUT = sys.stdout

def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, allow_nan=False), file=PROTOCOL_STDOUT, flush=True)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def load_model(path, threads):
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        if hasattr(torch, "compiler") and not hasattr(torch.compiler, "is_compiling"):
            torch.compiler.is_compiling = lambda: False
        torch.set_num_threads(threads)
        from mace.calculators import MACECalculator
        model = torch.load(path, map_location="cpu", weights_only=False)
        calculator = MACECalculator(models=[model], device="cpu", default_dtype="float64")
    versions = {name: importlib.metadata.version(name) for name in ["ase", "torch", "mace-torch", "numpy"]}
    versions["python"] = sys.version.split()[0]
    return calculator, {"label": "MACE-MPA-0 medium" if Path(path).name == "macempa0mediummodel" else "MACE local checkpoint",
                        "filename": Path(path).name, "sha256": digest(path), "runnerSha256": digest(__file__),
                        "device": "cpu", "dtype": "float64", "threads": threads,
                        "atomicNumbers": [int(z) for z in model.atomic_numbers.tolist()], "versions": versions}


def relax(request, calculator, model, root, created):
    import numpy as np
    from ase import Atoms
    from ase.constraints import FixScaled
    from ase.io import write
    from ase.optimize import FIRE
    from ase.neighborlist import neighbor_list
    candidate = request["candidate"]
    key = candidate["id"]
    if not key or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in key):
        raise ValueError("Invalid candidate ID")
    s, settings = candidate["structure"], request["settings"]
    cell, frac = np.asarray(s["cell"], dtype=float), np.asarray(s["fractional"], dtype=float)
    if not 1 <= len(s["elements"]) <= 128 or cell.shape != (3, 3) or frac.shape != (len(s["elements"]), 3):
        raise ValueError("Invalid structure dimensions")
    if not np.isfinite(cell).all() or not np.isfinite(frac).all() or abs(np.linalg.det(cell)) < 1e-6:
        raise ValueError("Invalid structure values")
    if s["pbc"] != [True, True, True]:
        raise ValueError("Only periodic crystals are supported")
    atoms = Atoms(symbols=s["elements"], cell=cell, scaled_positions=frac, pbc=True)
    unsupported = set(atoms.numbers.tolist()) - set(model["atomicNumbers"])
    if unsupported:
        raise ValueError("Checkpoint does not cover atomic numbers: " + str(sorted(unsupported)))
    if len(s["movable"]) != len(atoms) or any(len(flags) != 3 or any(type(x) is not bool for x in flags) for flags in s["movable"]):
        raise ValueError("Invalid Direct motion constraints")
    constraints = [FixScaled(i, mask=[not x for x in flags]) for i, flags in enumerate(s["movable"]) if not all(flags)]
    atoms.set_constraint(constraints)
    if len(neighbor_list("d", atoms, 0.5, self_interaction=False)):
        raise ValueError("Input has an atomic contact below 0.5 Angstrom")
    if not 0.005 <= settings["fmax"] <= 1 or not 1 <= settings["maxSteps"] <= 200:
        raise ValueError("Invalid relaxation limits")
    directory = root / key
    directory.mkdir(exist_ok=False)
    created.append(directory)
    (directory / "input.json").write_text(json.dumps({"candidate": candidate, "settings": settings, "model": model}, indent=2))
    started_at, started = now(), time.perf_counter()
    atoms.calc = calculator
    optimizer = FIRE(atoms, logfile=str(directory / "optimizer.log"), trajectory=str(directory / "relaxation.traj"), maxstep=0.15)

    def report():
        energy = float(atoms.get_potential_energy())
        force = float(np.linalg.norm(atoms.get_forces(), axis=1).max())
        if not math.isfinite(energy) or not math.isfinite(force) or not np.isfinite(atoms.positions).all():
            raise ValueError("Non-finite model result")
        if len(neighbor_list("d", atoms, 0.5, self_interaction=False)):
            raise ValueError("Relaxation produced an atomic contact below 0.5 Angstrom")
        progress = {"step": optimizer.nsteps, "energyEv": energy, "maxForceEvAngstrom": force,
                    "elapsedSeconds": time.perf_counter() - started, "fractional": atoms.get_scaled_positions(wrap=False).tolist()}
        with open(directory / "trajectory.jsonl", "a") as stream:
            stream.write(json.dumps(progress, allow_nan=False) + "\n")
        emit("progress", id=key, progress=progress)

    optimizer.attach(report, interval=1)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            converged = bool(optimizer.run(fmax=settings["fmax"], steps=settings["maxSteps"]))
    finally:
        optimizer.close()
    energy = float(atoms.get_potential_energy())
    max_force = float(np.linalg.norm(atoms.get_forces(), axis=1).max())
    raw_force = float(np.linalg.norm(atoms.get_forces(apply_constraint=False), axis=1).max())
    if not np.allclose(atoms.cell.array, cell, rtol=0, atol=1e-10):
        raise ValueError("Fixed-cell relaxation changed the lattice")
    result = {"converged": converged and max_force <= settings["fmax"], "energyEv": energy,
              "energyPerAtomEv": energy / len(atoms), "maxForceEvAngstrom": max_force,
              "rawMaxForceEvAngstrom": raw_force, "steps": optimizer.nsteps,
              "elapsedSeconds": time.perf_counter() - started, "startedAt": started_at, "finishedAt": now(),
              "structure": {**s, "fractional": atoms.get_scaled_positions(wrap=False).tolist()}}
    write(directory / "POSCAR.relaxed", atoms, format="vasp", direct=True, sort=False)
    (directory / "result.json").write_text(json.dumps(result, allow_nan=False, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    try:
        started = time.perf_counter()
        calculator, model = load_model(args.model_path, max(1, min(args.threads, 8)))
        emit("ready", model=model, loadSeconds=time.perf_counter() - started)
    except Exception as error:
        emit("fatal", error=type(error).__name__ + ": " + str(error)[:500])
        return 1
    root = Path(args.output_root)
    for line in sys.stdin:
        request = None
        created = []
        try:
            request = json.loads(line)
            result = relax(request, calculator, model, root, created)
            emit("result", id=request["candidate"]["id"], result=result)
        except Exception as error:
            message = type(error).__name__ + ": " + str(error)[:500]
            emit("error", id=request.get("candidate", {}).get("id") if request else None, error=message)
            if created:
                with open(created[0] / "failure.json", "x") as stream:
                    json.dump({"error": message, "at": now()}, stream)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
