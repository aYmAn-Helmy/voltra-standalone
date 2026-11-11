#!/usr/bin/env python3
"""Apply a reproducible PowerA branding overlay to the checked-out powerk Android project.

The original repository stays linked as a submodule rather than being republished.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import sys

REPLACEMENTS = (
    ("app/src/main/res/values/strings.xml", '<string name="app_name">powerk</string>', '<string name="app_name">PowerA</string>'),
    ("app/src/main/res/values-ar/strings.xml", '<string name="app_name">powerk</string>', '<string name="app_name">PowerA</string>'),
    ("settings.gradle.kts", 'rootProject.name = "powerk"', 'rootProject.name = "PowerA"'),
    ("app/build.gradle.kts", 'applicationId = "com.powerk.app"', 'applicationId = "com.powera.app"'),
)


def apply_branding(android_dir: Path, check: bool = False) -> list[str]:
    if not android_dir.is_dir():
        raise RuntimeError(f"Missing upstream Android checkout: {android_dir}. Run git submodule update --init --recursive.")
    changes = []
    for rel, old, new in REPLACEMENTS:
        path = android_dir / rel
        if not path.is_file():
            raise RuntimeError(f"Missing upstream file: {path}")
        content = path.read_text(encoding="utf-8")
        if new in content:
            continue
        if content.count(old) != 1:
            raise RuntimeError(f"Unexpected upstream content in {path}; no files have been changed.")
        changes.append((path, content.replace(old, new, 1)))
    if check:
        if changes:
            raise RuntimeError("The PowerA branding overlay has not been applied.")
        return []
    for path, content in changes:
        path.write_text(content, encoding="utf-8")
    return [str(path) for path, _ in changes]


def main() -> int:
    parser = argparse.ArgumentParser(description="Brand the local upstream Android checkout as PowerA.")
    parser.add_argument("--android-dir", type=Path, default=Path("upstream/powerk/android"))
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        changed = apply_branding(args.android_dir, check=args.check)
    except (OSError, RuntimeError) as exc:
        print(f"PowerA: {exc}", file=sys.stderr)
        return 1
    print("PowerA verified" if args.check else f"PowerA applied to {len(changed)} files")
    print("Launcher and in-app name: PowerA; application ID: com.powera.app")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
