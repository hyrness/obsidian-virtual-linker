# Obsidian Auto Linker

This plugin automatically inserts wiki (or markdown) links into your notes for text that matches the title or alias of another note in your vault. Linking happens in the background while you type, on a short debounce, so the note text on disk is updated in place — links show up in graph view, backlinks, and reference counting like any hand-written link.

This is a fork of [Obsidian Virtual Linker](https://github.com/vschroeter/obsidian-virtual-linker). The original plugin renders virtual link overlays without writing to disk; this fork removes the overlay layer and writes the links directly to your notes.

Features:

- glossary-style cross-linking with **no manual linking** required
- works with note **aliases** as well as titles
- inserts wiki-links (`[[Note]]`) or markdown links, configurable
- skips matches near the cursor, so the IME composition area stays untouched
- per-file include / exclude tags, per-directory include / exclude lists
- case sensitivity rules per file or per alias
- a vault-relative file (`linker-exclude.md` by default) lists words that should never be auto-linked

## Installing the plugin

Manual install:

- Copy `main.js`, `manifest.json`, and `styles.css` (from a release) into `<Vault>/.obsidian/plugins/auto-linker/`.
- Or clone the repository into the plugins folder of your vault and build it yourself (see below).

## Settings

### Auto-link

- **Auto-insert links while editing** — turns the auto-writer on/off. When on, matched terms are replaced with wiki/markdown links after a short idle delay (default 300 ms). The match the cursor is currently on is left untouched.
- **Auto-link debounce (ms)** — idle time after typing before the writer runs. Larger values are friendlier to IME composition but feel less responsive.
- **Excluded words file** — path to a markdown file listing words / phrases that should never be auto-linked, one per line. Lines starting with `#` or `-` are treated as comments / list bullets and stripped. Case-insensitive.

### Matched files

You can toggle the matching of files between:

- **Match all files**: every file in the vault is eligible.
- **Match only files in specific folders**: only files in the listed folders are eligible.

You can also explicitly include or exclude a file by tagging it (defaults shown):

- `linker-include` — force-include the file
- `linker-exclude` — force-exclude the file

You can also exclude all files in a specific folder with the directory exclude list, or skip auto-linking entirely while editing certain folders.

### Case sensitivity

Matching is case-insensitive by default. You can:

- Toggle global case sensitivity on/off
- Override per file with `linker-match-case` / `linker-ignore-case` tags
- Override per alias with frontmatter properties of the same names (each holding a list of names)

### Matching behavior

- **Match the beginning of words** / **Match the end of words** — control whether sub-word prefixes / suffixes count
- **Match any part of a word** — most permissive; e.g. "book" matches inside "Notebook"
- **Only link once** — keep only the first occurrence of each match in a note (Wikipedia-style)
- **Exclude links to already-linked files** — skip auto-links to files already linked manually in the note
- **Exclude self-links to the current note** — don't auto-link a note to itself
- **Avoid linking in current line** — disable auto-linking for the line the cursor is on
- **Fix IME problem** — recommended when typing with an IME (e.g. for Chinese / Japanese): suppresses links at the start of the current line so the IME composition isn't disturbed

### Link style

- **Use default link style for conversion** — when on, the auto-writer uses your vault's default link style (wiki vs. markdown, shortest / relative / absolute). Untoggle to override with the controls below.
- **Use [[Wiki-links]]** — wiki-style vs. markdown-style links
- **Link format** — `shortest` / `relative` / `absolute`

## Commands

The plugin registers the following commands; you can run them from the command palette or bind a hotkey to them in settings:

- **Activate Auto Linker** — enables auto-linking when it's currently off
- **Deactivate Auto Linker** — pauses auto-linking
- **Open Excluded Words File** — opens (or creates) the file pointed to by *Excluded words file*
- **Convert Wiki Links in Current Note to Plain Text…** — opens a dialog listing every `[[…]]` link in the current note grouped by display word, with a filter input and per-word checkboxes; selected words are reverted to plain text

## Context menu options

Right-clicking a file or folder in the file explorer adds these items:

- **\[Auto Linker\] Exclude this file** — adds the `linker-exclude` tag to the file's frontmatter
- **\[Auto Linker\] Include this file** — adds the `linker-include` tag to the file's frontmatter
- **\[Auto Linker\] Exclude this directory** — moves the directory into the exclude list
- **\[Auto Linker\] Include this directory** — moves the directory into the include list

## How to use for development

- Clone this repo (e.g. into `your-vault/.obsidian/plugins/`).
- `npm install` to install dependencies.
- `npm run dev` to start compilation in watch mode.
- `npm run build` to produce a release build (TypeScript check + minified `main.js`).
- `npm run build:deploy` builds and copies `main.js`, `manifest.json`, `styles.css` into `$OBSIDIAN_VAULT/.obsidian/plugins/auto-linker/`. Set `OBSIDIAN_VAULT` to your vault root (see `.envrc.example`).

It is recommended to use the [Hot Reload Plugin](https://github.com/pjeby/hot-reload) for development.
