# PowerA

**PowerA** is the dedicated development branch for customizing an Android controller for LG U+ / Jinheung MTTL-W01 smart power strips.

## Upstream reference

Based on the architecture and documented interfaces of [ahmedtohamy1/powerk](https://github.com/ahmedtohamy1/powerk), a Python controller + Kotlin/Jetpack Compose Android client. The upstream project is linked as a **Git submodule** in `upstream/powerk`, preserving its original source, history, authorship and update path.

This branch is separate from Voltra's `main` and `feat/central-dashboard` branches, so the two initiatives can evolve independently.

### Get the project

```bash
git clone --branch PowerA --recurse-submodules https://github.com/aYmAn-Helmy/voltra-standalone.git
cd voltra-standalone
# If it was cloned without submodules:
git submodule update --init --recursive
```

### Inspect/build upstream Android app

```bash
cd upstream/powerk/android
./gradlew assembleDebug
```

### Project identity

- **New project / workstream name:** PowerA
- **Development branch:** `PowerA`
- **Upstream implementation:** powerk, under `upstream/powerk`, unmodified
- **Planned application label / package:** PowerA / `com.powera.app` in our own Android implementation (not yet published)

### License and reuse status

**Important:** As checked on 2026-11-11, the upstream powerk repository did not publish a `LICENSE` file or GitHub-recognized license. A public repository can be inspected and linked, but this does **not automatically permit** copying, republishing, renaming and distributing its entire source or APK under another brand. We therefore intentionally keep it as an external Git submodule rather than committing a modified copy as PowerA.

Obtain an explicit license or written permission from the upstream owner before publishing a derivative application or copied source under PowerA. Development can proceed on original implementation and documented protocol integration in this branch.

## Next development targets

1. Create an independently authored **PowerA**-branded app shell (Android / Kotlin).
2. Integrate the stock MTTL-W01 protocol using authorized interfaces, or interface with the upstream powerk JSON API.
3. Optionally add Standalone firmware HTTP/SSE support alongside the stock controller.
4. Add automated tests and a distributable APK once redistribution rights and signing are settled.

For the upstream setup, provisioning steps and API documentation, see [the original Arabic README](https://github.com/ahmedtohamy1/powerk/blob/master/README.ar.md).
