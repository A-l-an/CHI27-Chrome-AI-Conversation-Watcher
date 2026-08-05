# Security and privacy

Do not commit participant packages, `participant_config.json`, ActivityWatch exports, OBS recordings, browser profiles, locator sidecars, logs, cookies, tokens, credentials, or private keys. Report suspected exposure privately to the repository owner; do not open a public issue containing sensitive material.

The extension package is intentionally built only from files reachable from `manifest.json`. The packaging script fails on missing, absolute, parent-traversing, symlinked, or forbidden paths. Generated artifacts are source/unpacked-extension ZIPs, not participant releases.

Synthetic tests and CI are not substitutes for a clean-machine end-to-end check with the intended Chrome, ActivityWatch, operating-system notification settings, and study workflow.
