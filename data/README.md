# Data

Dataset provenance is documented in `provenance.md`.

## Field Guide 03: When Toronto Has to Go

The dated Phase 1 proof is in `proof/fg03/2026-07-21/`. It combines official
public-washroom inventories, published weekly hours, current closure status,
the City Pedestrian Network, and the TTC GTFS schedule.

Reproduce the snapshot from the repository root:

```bash
python3 -m venv data/scripts/.venv
data/scripts/.venv/bin/pip install -r data/scripts/requirements-fg03.txt
data/scripts/.venv/bin/python data/scripts/20_download_washroom_proof.py
PYTHONPATH=data/scripts data/scripts/.venv/bin/python data/scripts/21_build_washroom_proof.py --snapshot-date 2026-07-21
```

The raw input snapshot is ignored because it is reproducible and includes an
approximately 77 MB GTFS archive. The proof output, curated TTC station list,
manual nearby-pair audit, processing code, and tests are versionable.

Run the focused tests with:

```bash
PYTHONPATH=data/scripts data/scripts/.venv/bin/python -m unittest discover -s data/scripts/tests -p 'test_fg03_*.py'
```
