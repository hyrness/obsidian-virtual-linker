# Skip auto-linking inside HTML comments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop auto-linking words that appear after `<!--` so that text inside HTML comments (including unclosed in-progress ones) is never wrapped in wiki/markdown links, eliminating the `[[[[word]]]]…` infinite-nesting regression.

**Architecture:**
The CodeMirror syntax tree does not reliably tag every region after `<!--` with a node type containing `"html"` (especially while the comment is still being typed and the closing `-->` is missing). We add a regex-based scanner that finds `<!-- … -->` ranges (treating an unclosed `<!--` as extending to end-of-input, per CommonMark HTML-block type 2) and inserts those absolute offsets into the existing `excludedIntervalTree` in `linker/liveLinker.ts`. The scanner is a pure helper, unit-tested with vitest.

**Tech Stack:** TypeScript, Obsidian plugin API, CodeMirror 6 (`@codemirror/language`, `@codemirror/view`), `@flatten-js/interval-tree`, esbuild. New: `vitest` for unit tests.

---

## File Structure

- **Create:** `linker/htmlComments.ts` — single exported pure helper `findHtmlCommentRanges(text: string): Array<[number, number]>`. Self-contained, no Obsidian/CodeMirror imports.
- **Create:** `linker/htmlComments.test.ts` — vitest suite for the helper.
- **Modify:** `linker/liveLinker.ts` — import the helper, call it once per visible range, and insert each `[start, end]` interval into `excludedIntervalTree` alongside the syntax-tree-derived intervals.
- **Modify:** `package.json` — add `vitest` devDependency and a `test` script.
- **Modify (only if needed):** `tsconfig.json` — add `node_modules/vitest` typings if `tsc -noEmit` complains; otherwise leave it.

`linker/htmlComments.ts` is intentionally tiny and string-only, so it is testable without mocking Obsidian or CodeMirror. Keeping it in the `linker/` directory groups it with the other linker internals (`linkerCache.ts`, `linkerInfo.ts`, `liveLinker.ts`) rather than scattering helpers into `main.ts`.

---

## Task 1: Set up vitest

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install vitest as a devDependency**

Run:
```bash
npm install --save-dev vitest@^1.6.0
```

Expected: `package.json` gets a `"vitest"` entry under `devDependencies`; `package-lock.json` updates; no other dependencies removed.

- [ ] **Step 2: Add a `test` script to `package.json`**

Edit `package.json`. Inside the `"scripts"` object, add a `"test"` entry. The full `"scripts"` object should look like:

```json
"scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "deploy": "mkdir -p \"${OBSIDIAN_VAULT:?Set OBSIDIAN_VAULT to your vault root, e.g. ~/Vault}/.obsidian/plugins/auto-linker\" && cp main.js manifest.json styles.css \"$OBSIDIAN_VAULT/.obsidian/plugins/auto-linker/\"",
    "build:deploy": "npm run build && npm run deploy",
    "test": "vitest run",
    "version": "node version-bump.mjs && git add manifest.json versions.json"
}
```

- [ ] **Step 3: Verify vitest runs**

Run:
```bash
npx vitest run --reporter=verbose
```

Expected: vitest prints `No test files found, exiting with code 0` (or equivalent) and exits 0. This proves vitest is installed and discoverable. Do NOT commit yet — Task 2 adds the first test.

---

## Task 2: Write the failing tests for `findHtmlCommentRanges`

**Files:**
- Create: `linker/htmlComments.test.ts`

- [ ] **Step 1: Create the test file with the full suite**

Create `linker/htmlComments.test.ts` with this exact content:

```typescript
import { describe, expect, it } from 'vitest';
import { findHtmlCommentRanges } from './htmlComments';

describe('findHtmlCommentRanges', () => {
    it('returns empty array for text with no comments', () => {
        expect(findHtmlCommentRanges('plain text without comments')).toEqual([]);
    });

    it('finds a single closed comment', () => {
        // Indices:    0         1
        //             0123456789012345
        // text:      'a <!-- b --> c'
        //               ^ start=2     ^ end=12 (exclusive, points just past '-->')
        expect(findHtmlCommentRanges('a <!-- b --> c')).toEqual([[2, 12]]);
    });

    it('extends an unclosed comment to end-of-input', () => {
        const text = 'a <!-- unclosed text';
        expect(findHtmlCommentRanges(text)).toEqual([[2, text.length]]);
    });

    it('finds multiple non-overlapping comments', () => {
        // text:      '<!-- a --> mid <!-- b -->'
        //  indices:   0         1         2
        //             0123456789012345678901234
        expect(findHtmlCommentRanges('<!-- a --> mid <!-- b -->')).toEqual([
            [0, 10],
            [15, 25],
        ]);
    });

    it('does not nest: the first --> closes the outer <!--', () => {
        // CommonMark: HTML comments do not nest. The first '-->' closes the open comment.
        // text:      '<!-- <!-- inner --> outer -->'
        //  indices:   0         1         2
        //             0123456789012345678901234567890
        // First '<!--' at 0, first '-->' at 16, end (exclusive) = 19.
        // After 19, ' outer -->' is plain text — no new '<!--' opens, so no second range.
        expect(findHtmlCommentRanges('<!-- <!-- inner --> outer -->')).toEqual([[0, 19]]);
    });

    it('handles a comment spanning multiple lines', () => {
        const text = 'before\n<!-- line1\nline2 -->\nafter';
        const start = text.indexOf('<!--');
        const end = text.indexOf('-->') + '-->'.length;
        expect(findHtmlCommentRanges(text)).toEqual([[start, end]]);
    });

    it('treats `<!-- -->` (empty comment) as a single range', () => {
        expect(findHtmlCommentRanges('<!-- -->')).toEqual([[0, 8]]);
    });

    it('returns empty for `-->` without an opening `<!--`', () => {
        // A stray '-->' is not a comment opener, so nothing should be flagged.
        expect(findHtmlCommentRanges('foo --> bar')).toEqual([]);
    });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run linker/htmlComments.test.ts
```

Expected: Tests fail because `linker/htmlComments.ts` does not exist yet. The error is an import-resolution error like `Cannot find module './htmlComments'` or `Failed to resolve import "./htmlComments"`. This is the Red step — do NOT proceed to commit.

---

## Task 3: Implement `findHtmlCommentRanges` (minimal Green)

**Files:**
- Create: `linker/htmlComments.ts`

- [ ] **Step 1: Write the helper**

Create `linker/htmlComments.ts` with this exact content:

```typescript
/**
 * Find all HTML-comment ranges `<!-- ... -->` in `text`.
 *
 * Returns an array of `[start, end]` pairs where `start` is the offset of the
 * first `<` of `<!--` and `end` is the offset just past the final `>` of `-->`
 * (so `text.slice(start, end)` yields the full comment).
 *
 * If a `<!--` is never closed, the range extends to `text.length` — this matches
 * CommonMark's HTML-block type 2 behavior (an unterminated comment swallows the
 * rest of the input) and ensures words typed after an in-progress `<!--` are
 * not auto-linked.
 *
 * Comments do not nest: the first `-->` after a `<!--` closes it, even if a
 * second `<!--` appears in between.
 */
export function findHtmlCommentRanges(text: string): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    let i = 0;
    while (i < text.length) {
        const start = text.indexOf('<!--', i);
        if (start === -1) break;
        const closeIdx = text.indexOf('-->', start + 4);
        if (closeIdx === -1) {
            ranges.push([start, text.length]);
            break;
        }
        const end = closeIdx + 3;
        ranges.push([start, end]);
        i = end;
    }
    return ranges;
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run:
```bash
npx vitest run linker/htmlComments.test.ts
```

Expected: All 8 tests pass. Output ends with something like `Tests  8 passed (8)`.

- [ ] **Step 3: Run TypeScript type-check**

Run:
```bash
npx tsc -noEmit -skipLibCheck
```

Expected: Exit code 0, no output. This catches any signature mismatches before we wire it into `liveLinker.ts`.

- [ ] **Step 4: Commit Tasks 1–3**

```bash
git add package.json package-lock.json linker/htmlComments.ts linker/htmlComments.test.ts
git commit -m "Add findHtmlCommentRanges helper and vitest setup"
```

---

## Task 4: Wire the helper into `liveLinker.ts`

**Files:**
- Modify: `linker/liveLinker.ts` (import line near top; body of `buildDecorations`'s `for (let { from, to } of view.visibleRanges)` loop)

Context: in `linker/liveLinker.ts:298–338`, the existing code builds an `excludedIntervalTree` by walking the syntax tree. We add HTML-comment ranges to the same tree right after it is constructed and before `syntaxTree(view.state).iterate(...)` runs — order doesn't matter functionally because `IntervalTree.insert` is commutative, but inserting first keeps the regex-based fallback visually grouped with the comment that explains it.

- [ ] **Step 1: Add the import**

Edit `linker/liveLinker.ts`. After the existing import of `buildRealLinkReplacement` (currently at line 10), add a new import line. The relevant import block should become:

```typescript
import { ExternalUpdateManager, LinkerCache, PrefixTree } from './linkerCache';
import { VirtualMatch } from './virtualLinkDom';
import { buildRealLinkReplacement } from './linkerInfo';
import { findHtmlCommentRanges } from './htmlComments';
```

- [ ] **Step 2: Insert HTML-comment ranges into `excludedIntervalTree`**

In `linker/liveLinker.ts`, locate the existing block (currently around lines 293–300):

```typescript
            // We want to exclude some syntax nodes from being decorated,
            // such as code blocks and manually added links.
            //
            // 'html'/'HTML' covers raw HTML/HTML-like tags such as <thinking> or <div>.
            // Without these, the inner tag name gets auto-linked to a matching note,
            // and Obsidian keeps parsing the wrapper as HTML even after the replacement,
            // so each debounced flush nests the wikilink one level deeper — an infinite loop.
            const excludedIntervalTree = new IntervalTree();
            const excludedTypes = ['codeblock', 'code-block', 'inline-code', 'internal-link', 'link', 'url', 'hashtag', 'formatting-list-ol', 'hmd-html', 'html', 'HTML'];
```

Replace it with:

```typescript
            // We want to exclude some syntax nodes from being decorated,
            // such as code blocks and manually added links.
            //
            // 'html'/'HTML' covers raw HTML/HTML-like tags such as <thinking> or <div>.
            // Without these, the inner tag name gets auto-linked to a matching note,
            // and Obsidian keeps parsing the wrapper as HTML even after the replacement,
            // so each debounced flush nests the wikilink one level deeper — an infinite loop.
            const excludedIntervalTree = new IntervalTree();
            const excludedTypes = ['codeblock', 'code-block', 'inline-code', 'internal-link', 'link', 'url', 'hashtag', 'formatting-list-ol', 'hmd-html', 'html', 'HTML'];

            // HTML comments (`<!-- ... -->`) sometimes evade the syntax-tree-based
            // exclusion above — particularly while the closing `-->` is still being
            // typed, where the parser may not yet flag the region as HTML. Detect
            // them directly from the text as a safety net. Per CommonMark, an
            // unclosed `<!--` extends to end-of-input, so we exclude that whole tail
            // until the user types the closing `-->`.
            for (const [cStart, cEnd] of findHtmlCommentRanges(text)) {
                excludedIntervalTree.insert([from + cStart, from + cEnd]);
            }
```

Note: `text` and `from` are already in scope (declared at the top of this `for (let { from, to } of view.visibleRanges)` iteration — see lines 229–231). The offsets returned by `findHtmlCommentRanges` are relative to `text`, so we add `from` to convert them to absolute document offsets that match the syntax-tree ranges.

- [ ] **Step 3: Type-check**

Run:
```bash
npx tsc -noEmit -skipLibCheck
```

Expected: Exit code 0, no output.

- [ ] **Step 4: Run the full test suite**

Run:
```bash
npm test
```

Expected: All 8 tests in `linker/htmlComments.test.ts` still pass. (No new tests yet — the wiring change is harder to unit-test without mocking CodeMirror, so we rely on the helper's tests plus the manual smoke test in Task 5.)

- [ ] **Step 5: Run the production build**

Run:
```bash
npm run build
```

Expected: `tsc` succeeds and esbuild produces an updated `main.js` in the project root. No errors printed.

- [ ] **Step 6: Commit**

```bash
git add linker/liveLinker.ts
git commit -m "Skip auto-linking inside HTML comments"
```

---

## Task 5: Manual smoke test in Obsidian

**Files:** none (validation only)

Pre-condition: `OBSIDIAN_VAULT` is set in the user's shell. The user has confirmed via `CLAUDE.md` that `npm run build:deploy` is the dev loop.

- [ ] **Step 1: Deploy to the local vault**

Run:
```bash
npm run build:deploy
```

Expected: `main.js`, `manifest.json`, and `styles.css` are copied into `$OBSIDIAN_VAULT/.obsidian/plugins/auto-linker/`. The script prints the `cp` output (or nothing) and exits 0. If `OBSIDIAN_VAULT` is unset the script fails fast with a clear message — that is correct behavior, not a bug to fix.

- [ ] **Step 2: Reload the plugin**

Tell the user: open Obsidian, go to Settings → Community plugins, toggle **Auto Linker** off and on (or restart Obsidian) so the new `main.js` is loaded. The user must do this — it cannot be automated from here.

- [ ] **Step 3: Reproduce the original bug, then verify the fix**

Tell the user to open a note that contains at least one term that would normally auto-link to an existing note (call it `Foo`). Then ask them to perform these three checks and report any deviation:

1. **Closed comment.** Type a line `<!-- Foo -->`. Wait at least 1 second (longer than the auto-link debounce). Expected: `Foo` inside the comment is NOT converted to `[[Foo]]`. Outside the comment, on other lines, `Foo` should still auto-link as before.
2. **Unclosed comment (the original bug).** On a fresh line, type `<!-- Foo` (no closing `-->`). Wait 1+ seconds. Expected: `Foo` is NOT linked, and there is no infinite nesting (no `[[[[Foo]]]]`). Then type the closing ` -->`. The `Foo` inside should remain unlinked.
3. **No regression on regular text.** On a fresh line, type just `Foo` with no surrounding comment. Wait 1+ seconds. Expected: it auto-links to `[[Foo]]` as before.

If any of these three cases misbehave, do not declare the fix complete — investigate (likely a node-type or offset issue in the wiring) and iterate.

- [ ] **Step 4: If everything works, no further commit is needed**

The implementation is already committed in Task 4. This task is validation only.

---

## Self-Review

**Spec coverage:** The user reported "words after `<!--` are infinitely linked; make them not link." The plan's helper covers both closed and unclosed comments; Task 4 wires the helper into the only path that produces auto-links (`buildDecorations` → `excludedIntervalTree` → `VirtualMatch.filterOverlapping`); Task 5 verifies the original infinite-nesting case (`<!-- Foo` unclosed) plus a closed-comment case and a no-regression case. Covered.

**Placeholder scan:** No "TBD", "implement later", "add appropriate error handling", or "similar to Task N" in the plan. Every code step contains real code; every command step contains a real command and an expected outcome.

**Type consistency:** The helper is exported as `findHtmlCommentRanges(text: string): Array<[number, number]>` in Task 3 and consumed with the same signature in Task 4 (`for (const [cStart, cEnd] of findHtmlCommentRanges(text))`). Offsets are document-relative after `from + cStart` / `from + cEnd`, matching the absolute offsets that `IntervalTree.insert` expects (used the same way for syntax-tree nodes via `node.from` / `node.to`).
