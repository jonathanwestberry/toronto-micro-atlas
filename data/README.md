# Data

Dataset provenance is documented in `provenance.md`.

## Field Guide 03: When Toronto Has to Go

The dated Phase 1 proof is in `proof/fg03/2026-07-21/`. The audited Phase 2
analysis is in `proof/fg03/2026-07-21/phase2/`, and its browser-safe contract is
in `../public/data/fg03/2026-07-21/`. Together they combine official
public-washroom inventories, published weekly hours, current closure status,
the City Pedestrian Network, and the TTC GTFS schedule.

Reproduce the snapshot from the repository root:

```bash
python3 -m venv data/scripts/.venv
data/scripts/.venv/bin/pip install -r data/scripts/requirements-fg03.txt
data/scripts/.venv/bin/python data/scripts/20_download_washroom_proof.py
PYTHONPATH=data/scripts data/scripts/.venv/bin/python data/scripts/21_build_washroom_proof.py --snapshot-date 2026-07-21
```

Then build the network analysis from the same frozen raw snapshot:

```bash
data/scripts/.venv/bin/python data/scripts/22_build_washroom_analysis.py \
  --snapshot-date 2026-07-21 \
  --proof-dir data/proof/fg03/2026-07-21 \
  --raw-dir /absolute/path/to/toronto-micro-atlas/data/raw/fg03 \
  --public-dir public/data/fg03/2026-07-21
```

The Phase 2 build validates the pedestrian graph, applies the reviewed
topology and length exceptions in `fg03/network-topology-exceptions.csv`,
evaluates the complete time by access by walking-distance matrix, applies only
audit decisions tied to the current analysis hash, enforces the release gate,
and publishes outputs atomically. `phase2/manual-audit.csv` is generated
evidence; `fg03/phase2-audit-decisions.csv` is the curated decision source.
Never copy generated ranks or metrics into the decision file.

The raw input snapshot is ignored because it is reproducible and includes an
approximately 77 MB GTFS archive. The proof output, curated TTC station list,
manual nearby-pair audit, topology exceptions, Phase 2 audit decisions,
processing code, and tests are versionable.

The public contract is schema version 1. It includes dated facilities,
interventions, four stop snapshots, and real 300/400/500 metre pedestrian
network reaches. It contains no raw trip IDs. Fare-paid TTC washrooms remain
visible for the rider-conditional view but never seed unrestricted public
coverage. The audited release gate passes with 25 robust material
opportunities: 10 hours extensions, 6 new-facility investigation zones, and 9
information-verification actions.

Run the focused tests with:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover \
  -s data/scripts/tests -p 'test_fg03*.py' -v
```
