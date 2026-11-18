#!/usr/bin/env python3
"""Build the UI preview from the real extension sources.

Copies extension/* into preview/ and produces `options-preview.html`, which loads
the mocked chrome.* API before the real options script. Re-run after changing the
options page:

    python tools/make_preview.py
    cd preview && python3 -m http.server 8080
"""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
OUT = ROOT / "preview"

MOCK_TAG = '<script src="mock.js"></script>'


def inject_mock(html: str) -> str:
    marker = '<script type="module" src="options.js"></script>'
    if marker not in html:
        raise SystemExit("Could not find the options.js script tag to inject before")
    return html.replace(marker, f"{MOCK_TAG}\n    {marker}")


def main() -> None:
    OUT.mkdir(exist_ok=True)

    # Copy the assets the page needs, leaving the hand-written preview files alone.
    for item in EXT.rglob("*"):
        if item.is_file():
            target = OUT / item.relative_to(EXT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)

    (OUT / "options-preview.html").write_text(
        inject_mock((EXT / "options.html").read_text()), encoding="utf-8"
    )
    print(f"preview written to {OUT}")
    print("  run:  cd preview && python3 -m http.server 8080  ->  http://localhost:8080")


if __name__ == "__main__":
    main()
