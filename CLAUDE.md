# real-link (Auto Real Linker) — project notes

## Dev loop

For local Obsidian testing, the build artifacts must be copied into the vault's plugin directory. Set the vault root once via an environment variable, e.g. by copying `.envrc.example` to `.envrc` (loaded automatically by direnv) or simply exporting it in your shell:

```sh
export OBSIDIAN_VAULT="$HOME/Vault"
```

Then:

- `npm run build:deploy` — runs the build and copies `main.js`, `manifest.json`, and `styles.css` into `$OBSIDIAN_VAULT/.obsidian/plugins/auto-real-linker/`. Use this during development. The script intentionally fails with a clear message if `OBSIDIAN_VAULT` is unset, so a fresh clone never silently copies into the wrong place.
- `npm run build` — pure build (no deploy). Used for CI and release packaging so a clone without the env var still builds.

`data.json` (user settings) is never touched by the deploy step.
