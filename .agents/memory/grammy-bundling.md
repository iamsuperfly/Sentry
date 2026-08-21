---
name: grammY bundling
description: Build constraint for the Telegram backend's Node runtime adapter.
---

When bundling the Telegram backend with esbuild, keep the `grammy` package external so Node can resolve its relative platform adapter files from the installed package.

**Why:** Flattening grammY into the server bundle caused the Node adapter to look for a missing `platform.node` module at runtime.

**How to apply:** Preserve grammY in the build's external dependency list and ensure it remains a runtime dependency of the API server.