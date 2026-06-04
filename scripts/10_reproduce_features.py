#!/usr/bin/env python3
"""Project entrypoint for feature reproduction.

The canonical implementation is embedded by the Go backend from
backend/reproduction_assets/10_reproduce_features.py so downloaded packages
and repo-local runs use the same script.
"""

from pathlib import Path
import runpy


SCRIPT = Path(__file__).resolve().parents[1] / "backend" / "reproduction_assets" / "10_reproduce_features.py"
runpy.run_path(str(SCRIPT), run_name="__main__")
