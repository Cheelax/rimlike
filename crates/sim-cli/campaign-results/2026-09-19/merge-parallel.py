#!/usr/bin/env python3
"""Validate and merge the 60 independent final K=30 campaign outputs.

Run with --wall-ms from execution.shared_wall_ms in the archived aggregate.
--check verifies both aggregates without writing. Python standard library only.
"""
import argparse
import json
from pathlib import Path

BASE = Path(__file__).resolve().parent
MODES = {"present": None, "absent": 8}
CONFIG = {
    "seeds": 1,
    "days": 30,
    "size": 64,
    "biome": 4,
    "biome_name": "forêt tempérée",
    "difficulty": "normal",
    "climate": None,
    "day_of_year": 0,
    "day_scale": 30,
    "ticks": 12_960_000,
}


def merge(mode, wall_ms):
    parts = []
    for seed in range(1, 31):
        path = BASE / "shelter-k30-parts" / f"{mode}-{seed:02}.json"
        data = json.loads(path.read_text())
        campaign = data["campaign"]
        expected = {**CONFIG, "first_seed": seed, "absent_from": MODES[mode]}
        for key, value in expected.items():
            if campaign.get(key) != value:
                raise ValueError(f"{path.name}: {key} differs")
        if len(data["runs"]) != 1 or data["runs"][0]["seed"] != seed:
            raise ValueError(f"{path.name}: wrong seed or truncated run")
        run = data["runs"][0]
        if run["lost_events"] != 0:
            raise ValueError(f"{path.name}: lost events")
        if not isinstance(campaign["elapsed_ms"], int) or campaign["elapsed_ms"] < 0:
            raise ValueError(f"{path.name}: invalid elapsed time")
        parts.append(data)
    campaign = dict(parts[0]["campaign"])
    campaign.update(
        seeds=30,
        first_seed=1,
        ticks=sum(p["campaign"]["ticks"] for p in parts),
        elapsed_ms=wall_ms,
        execution={
            "mode": "parallel-seeds",
            "workers": 8,
            "shared_wall_ms": wall_ms,
            "sum_part_ms": sum(p["campaign"]["elapsed_ms"] for p in parts),
        },
    )
    return {"campaign": campaign, "runs": [p["runs"][0] for p in parts]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wall-ms", type=int, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.wall_ms < 0:
        parser.error("--wall-ms must be nonnegative")
    expected_names = {f"{mode}-{seed:02}.json" for mode in MODES for seed in range(1, 31)}
    names = {p.name for p in (BASE / "shelter-k30-parts").glob("*.json")}
    if names != expected_names:
        raise ValueError("Expected exactly 60 named campaign parts")
    merged = {mode: merge(mode, args.wall_ms) for mode in MODES}
    # Validate every input before modifying either aggregate.
    for mode, data in merged.items():
        target = BASE / f"shelter-k30-{mode}.json"
        if args.check:
            if json.loads(target.read_text()) != data:
                raise ValueError(f"{target.name}: aggregate differs")
        else:
            target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print(f"{target.name}: 30 seeds, no lost events, {'verified' if args.check else 'written'}")


if __name__ == "__main__":
    main()
