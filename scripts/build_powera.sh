#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
git submodule update --init --recursive
python3 scripts/brand_powera.py
cd upstream/powerk/android
./gradlew :app:assembleDebug
printf "\nPowerA APK: %s\n" "$PWD/app/build/outputs/apk/debug/app-debug.apk"
