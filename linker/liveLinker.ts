import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, PluginSpec, PluginValue, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { App, MarkdownView, TFile, Vault } from 'obsidian';

import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { ExternalUpdateManager, LinkerCache, PrefixTree } from './linkerCache';
import { VirtualMatch } from './virtualLinkDom';
import { buildRealLinkReplacement } from './linkerInfo';

interface AutoLinkCandidate {
    from: number;
    to: number;
    file: TFile;
    displayText: string;
}

function isDescendant(parent: HTMLElement, child: HTMLElement, maxDepth: number = 10) {
    let node = child.parentNode;
    let depth = 0;
    while (node != null && depth < maxDepth) {
        if (node === parent) {
            return true;
        }
        node = node.parentNode;
        depth++;
    }
    return false;
}

export class VirtualLinkWidget extends WidgetType {
    constructor(public match: VirtualMatch) {
        super();
    }
    toDOM(view: EditorView): HTMLElement {
        return this.match.getCompleteLinkElement();
    }
}

class AutoLinkerPlugin implements PluginValue {
    decorations: DecorationSet;
    app: App;
    vault: Vault;
    linkerCache: LinkerCache;

    settings: LinkerPluginSettings;

    private lastCursorPos: number = 0;
    private lastActiveFile: string = '';
    private lastViewUpdate: ViewUpdate | null = null;

    // Buffered candidates for the auto-link-on-edit feature.
    // Populated during buildDecorations, consumed by the debounced flushAutoLinks.
    private autoLinkCandidates: AutoLinkCandidate[] = [];
    private autoLinkTimer: number | null = null;
    private autoLinkActiveFilePath: string = '';

    viewUpdateDomToFileMap: Map<HTMLElement, TFile | undefined | null> = new Map();

    constructor(view: EditorView, app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager) {
        this.app = app;
        this.settings = settings;

        const { vault } = this.app;
        this.vault = vault;

        this.linkerCache = LinkerCache.getInstance(app, this.settings);

        this.decorations = this.buildDecorations(view);

        updateManager.registerCallback(() => {
            if (this.lastViewUpdate) {
                this.update(this.lastViewUpdate, true);
            }
        });
    }

    update(update: ViewUpdate, force: boolean = false) {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);

        // Check if the update is on the active view. We only need to check this, if one of the following settings is enabled
        // - fixIMEProblem
        // - excludeLinksToOwnNote
        // - excludeLinksInCurrentLine
        let updateIsOnActiveView = false;
        if (this.settings.fixIMEProblem || this.settings.excludeLinksInCurrentLine || this.settings.excludeLinksToOwnNote) {
            const domFromUpdate = update.view.dom;
            const domFromWorkspace = activeView?.contentEl;
            updateIsOnActiveView = domFromWorkspace ? isDescendant(domFromWorkspace, domFromUpdate, 3) : false;

            // We store this information to be able to map the view updates to a obsidian file
            if (updateIsOnActiveView) {
                this.viewUpdateDomToFileMap.set(domFromUpdate, activeView?.file);
            }
        }

        const cursorPos = update.view.state.selection.main.from;
        const activeFile = this.app.workspace.getActiveFile()?.path;
        const fileChanged = activeFile != this.lastActiveFile;
        const cursorMoved = this.lastCursorPos !== cursorPos;

        if (force || cursorMoved || update.docChanged || fileChanged || update.viewportChanged) {
            this.lastCursorPos = cursorPos;
            this.linkerCache.updateCache(force);
            this.decorations = this.buildDecorations(update.view, updateIsOnActiveView);
            this.lastActiveFile = activeFile ?? '';
            this.autoLinkActiveFilePath = activeFile ?? '';
        }

        this.lastViewUpdate = update;

        // Schedule a debounced auto-link pass for any meaningful change:
        //   - doc edits
        //   - opening/switching to a new file
        //   - cursor moves (so a match that was skipped because it was on the
        //     current line gets converted once the cursor leaves)
        if (
            this.settings.linkerActivated &&
            this.settings.autoLinkOnEdit &&
            updateIsOnActiveView &&
            (update.docChanged || fileChanged || cursorMoved)
        ) {
            this.scheduleAutoLink(update.view);
        }
    }

    destroy() {
        if (this.autoLinkTimer !== null) {
            window.clearTimeout(this.autoLinkTimer);
            this.autoLinkTimer = null;
        }
    }

    private scheduleAutoLink(view: EditorView) {
        if (this.autoLinkTimer !== null) {
            window.clearTimeout(this.autoLinkTimer);
        }
        const delay = Math.max(100, this.settings.autoLinkDebounceMs ?? 800);
        this.autoLinkTimer = window.setTimeout(() => {
            this.autoLinkTimer = null;
            this.flushAutoLinks(view);
        }, delay);
    }

    private flushAutoLinks(view: EditorView) {
        if (!this.settings.linkerActivated || !this.settings.autoLinkOnEdit) return;
        if (this.autoLinkCandidates.length === 0) return;

        const docLength = view.state.doc.length;

        // Sort by start so we can skip overlaps and apply changes in order.
        const sorted = [...this.autoLinkCandidates].sort((a, b) => a.from - b.from || b.to - a.to);

        const changes: { from: number; to: number; insert: string }[] = [];
        let lastTo = -1;
        for (const cand of sorted) {
            if (cand.from < lastTo) continue; // overlap with a previously chosen replacement
            if (cand.to > docLength) continue; // doc shrank under us

            // Verify the text at [from, to] still matches what we captured.
            // The doc may have changed during the debounce window.
            const currentText = view.state.doc.sliceString(cand.from, cand.to);
            if (currentText !== cand.displayText) continue;

            // Defense against runaway re-linking when the syntax tree fails to
            // flag an existing wiki/markdown link (e.g. inside an HTML wrapper).
            // If the immediate surroundings already form a link, don't wrap again.
            const before = view.state.doc.sliceString(Math.max(0, cand.from - 2), cand.from);
            const after = view.state.doc.sliceString(cand.to, Math.min(docLength, cand.to + 2));
            if (before.endsWith('[[') && after.startsWith(']]')) continue;
            if (before.endsWith('[') && after.startsWith('](')) continue;

            const replacement = buildRealLinkReplacement(
                this.app,
                this.settings,
                cand.file,
                cand.displayText,
                this.autoLinkActiveFilePath,
            );
            if (!replacement) continue;

            changes.push({ from: cand.from, to: cand.to, insert: replacement });
            lastTo = cand.to;
        }

        // Clear the buffer regardless; the next buildDecorations pass will repopulate it.
        this.autoLinkCandidates = [];

        if (changes.length === 0) return;

        view.dispatch({
            changes,
            // Keep the user's selection where it is (CodeMirror auto-maps positions through changes).
            // No userEvent name, so this still creates an undo entry the user can revert.
        });
    }

    buildDecorations(view: EditorView, viewIsActive: boolean = true): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        // Reset the auto-link buffer; we re-collect on every pass.
        this.autoLinkCandidates = [];

        if (!this.settings.linkerActivated) {
            return builder.finish();
        }

        // Lowercased blocklist for O(1) per-match filtering. Empty when unset.
        const excludedWordsSet = new Set(
            (this.settings.excludedWords ?? []).map((w) => w.toLowerCase())
        );

        const dom = view.dom;
        const mappedFile = this.viewUpdateDomToFileMap.get(dom);

        // The excluded-words file is a config file by purpose: linkifying its entries
        // would race with the parser that turns those entries into exclusions, and would
        // rewrite the user's exclusion list as soon as they typed a matching filename.
        const excludedWordsFile = this.settings.excludedWordsFile?.trim();
        if (excludedWordsFile) {
            const currentPath = mappedFile?.path ?? this.app.workspace.getActiveFile()?.path;
            if (currentPath === excludedWordsFile) return builder.finish();
        }

        // Check if the file is inside excluded folders
        const excludedFolders = this.settings.excludedDirectoriesForLinking;
        if (excludedFolders.length > 0) {
            const path = mappedFile?.parent?.path ?? this.app.workspace.getActiveFile()?.parent?.path;
            if (excludedFolders.includes(path ?? '')) return builder.finish();
        }

        // Set to exclude file that are explicitly linked
        const explicitlyLinkedFiles = new Set<TFile>();

        // Set to exclude files that are already linked by a virtual link
        const alreadyLinkedFiles = new Set<TFile>();

        for (let { from, to } of view.visibleRanges) {
            this.linkerCache.reset();
            const text = view.state.doc.sliceString(from, to);

            // For every glossary file and its aliases we now search the text for occurrences
            // const additions: { id: number; files: TFile[]; from: number; to: number; widget: WidgetType }[] = [];
            let matches: VirtualMatch[] = [];
            let id = 0;
            let prevChar: string | undefined = undefined;
            // Iterate over every char in the text
            for (let i = 0; i <= text.length; i) {
                // Do this to get unicode characters as whole chars and not only half of them
                const codePoint = text.codePointAt(i)!;
                const char = i < text.length ? String.fromCodePoint(codePoint) : '\n';

                // If we are at a word boundary, get the current fitting files
                const isWordBoundary = PrefixTree.checkWordBoundary(char, prevChar); // , this.settings.wordBoundaryRegex
                if (this.settings.matchAnyPartsOfWords || this.settings.matchBeginningOfWords || isWordBoundary) {
                    const currentNodes = this.linkerCache.cache.getCurrentMatchNodes(
                        i,
                        this.settings.excludeLinksToOwnNote ? mappedFile : null
                    );

                    if (currentNodes.length > 0) {
                        // console.log('NODES', currentNodes);
                        for (const node of currentNodes) {
                            // Check if we want to include this note based on the settings
                            if (!this.settings.matchAnyPartsOfWords) {
                                if (
                                    (this.settings.matchBeginningOfWords && !node.startsAtWordBoundary) ||
                                    (this.settings.matchEndOfWords && !isWordBoundary)
                                ) {
                                    continue;
                                }
                            }

                            const nFrom = node.start;
                            const nTo = node.end;
                            const name = text.slice(nFrom, nTo);
                            const isAlias = node.isAlias;

                            const aFrom = from + nFrom;
                            const aTo = from + nTo;

                            // console.log("MATCH", name, aFrom, aTo, node.caseIsMatched, node.requiresCaseMatch)

                            matches.push(
                                new VirtualMatch(id++, name, aFrom, aTo, Array.from(node.files), isAlias, !isWordBoundary, this.settings)
                            );
                        }
                    }
                }

                // Push the char to get the next nodes in the prefix tree
                this.linkerCache.cache.pushChar(char, prevChar);
                prevChar = char;

                i += char.length;
            }

            // Sort additions by position and files length
            matches = VirtualMatch.sort(matches);

            // We want to exclude some syntax nodes from being decorated,
            // such as code blocks and manually added links.
            //
            // 'html'/'HTML' covers raw HTML/HTML-like tags such as <thinking> or <div>.
            // Without these, the inner tag name gets auto-linked to a matching note,
            // and Obsidian keeps parsing the wrapper as HTML even after the replacement,
            // so each debounced flush nests the wikilink one level deeper — an infinite loop.
            const excludedIntervalTree = new IntervalTree();
            const excludedTypes = ['codeblock', 'code-block', 'inline-code', 'internal-link', 'link', 'url', 'hashtag', 'formatting-list-ol', 'hmd-html', 'html', 'HTML'];

            if (!this.settings.includeHeaders) {
                excludedTypes.push('header-');
            }

            // We also want to exclude links to files that are already linked by a real link
            const app = this.app;
            syntaxTree(view.state).iterate({
                from,
                to,
                enter(node) {
                    const type = node.type.name;
                    const types = type.split('_');
                    // const text = view.state.doc.sliceString(node.from, node.to);
                    // console.log(text, node.type.name, types, node.from, node.to)

                    for (const excludedType of excludedTypes) {
                        if (type.contains(excludedType)) {
                            excludedIntervalTree.insert([node.from, node.to]);

                            // Types can be combined, e.g. internal-link_link-has-alias
                            // These combined types are separated by underscores
                            const isLinkIfHavingTypes = [['string', 'url'], 'hmd-internal-link', 'internal-link'];

                            isLinkIfHavingTypes.forEach((t) => {
                                const tList = Array.isArray(t) ? t : [t];

                                if (tList.every((tt) => types.includes(tt))) {
                                    const text = view.state.doc.sliceString(node.from, node.to);
                                    const linkedFile = app.metadataCache.getFirstLinkpathDest(text, mappedFile?.path ?? '');
                                    if (linkedFile) {
                                        explicitlyLinkedFiles.add(linkedFile);
                                    }
                                }
                            });
                        }
                    }
                },
            });

            // Delete additions that links to already linked files
            if (this.settings.excludeLinksToRealLinkedFiles) {
                matches = VirtualMatch.filterAlreadyLinked(matches, explicitlyLinkedFiles);
            }

            // Delete additions that links to already linked files
            if (this.settings.onlyLinkOnce) {
                matches = VirtualMatch.filterAlreadyLinked(matches, alreadyLinkedFiles);
            }

            // Delete additions that overlap
            // Additions are sorted by from position and after that by length, we want to keep longer additions
            matches = VirtualMatch.filterOverlapping(matches, this.settings.onlyLinkOnce, excludedIntervalTree);

            // Store the files that are linked by a virtual link
            matches.forEach((addition) => addition.files.forEach((f) => alreadyLinkedFiles.add(f)));

            // Get the cursor position
            const cursorPos = view.state.selection.main.from;

            // Settings if we want to adapt links in the current line / fix IME problem
            const excludeLine = viewIsActive && this.settings.excludeLinksInCurrentLine;
            const fixIMEProblem = viewIsActive && this.settings.fixIMEProblem;
            let needImeFix = false;

            // Get the line start and end positions if we want to exclude links in the current line
            // or if we want to fix the IME problem
            const lineStart = view.state.doc.lineAt(cursorPos).from;
            const lineEnd = view.state.doc.lineAt(cursorPos).to;

            matches.forEach((addition) => {
                const [from, to] = [addition.from, addition.to];
                const cursorNearby = cursorPos >= from - 0 && cursorPos <= to + 0;

                const additionIsInCurrentLine = from >= lineStart && to <= lineEnd;

                if (fixIMEProblem) {
                    needImeFix = true;
                    if (additionIsInCurrentLine && cursorPos > to) {
                        let gapString = view.state.sliceDoc(to, cursorPos);
                        let strBeforeAdd = view.state.sliceDoc(lineStart, from);

                        // Regex to check if a part of a word is at the line start, because IME problem only occurs at line start
                        // Regex matches parts that:
                        // - are completely empty or contain only whitespace.
                        // - start with a hyphen followed by one or more spaces.
                        // - start with 1 to 6 hash symbols followed by a space.
                        // - start with one or more greater-than signs followed by optional whitespace.
                        // - start with a hyphen followed by one or more spaces, then 1 to 6 hash symbols, and then one or more spaces.
                        // - start with a greater-than sign followed by a space, an exclamation mark within square brackets containing word characters or hyphens, an optional plus or minus sign, and one or more spaces.
                        const regAddInLineStart =
                            /(^\s*$)|(^\s*- +$)|(^\s*#{1,6} $)|(^\s*>+ *$)|(^\s*- +#{1,6} +$)|(^\s*> \[![\w-]+\][+-]? +$)/;

                        // check add is at line start
                        if (!regAddInLineStart.test(strBeforeAdd)) {
                            needImeFix = false;
                        }
                        // check the string between addition and cursorPos, check if it might be IME on.
                        else {
                            const regStrMayIMEon = /^[a-zA-Z]+[a-zA-Z' ]*[a-zA-Z]$|^[a-zA-Z]$/;
                            if (!regStrMayIMEon.test(gapString) || /[' ]{2}/.test(gapString)) {
                                needImeFix = false;
                            }
                        }
                    } else {
                        needImeFix = false;
                    }
                }

                if (!cursorNearby && !needImeFix && !(excludeLine && additionIsInCurrentLine)) {
                    // Virtual-link rendering is intentionally disabled:
                    // matches are converted to real links on the next debounced flush.
                    // We only require that the cursor is NOT inside the match
                    // (cursorNearby check above) — same-line matches past the cursor
                    // are eligible. This makes auto-linking feel responsive while
                    // typing without disturbing the area the IME is composing in.
                    if (
                        viewIsActive &&
                        this.settings.autoLinkOnEdit &&
                        addition.files.length === 1 &&
                        !excludedWordsSet.has(addition.originText.toLowerCase())
                    ) {
                        this.autoLinkCandidates.push({
                            from,
                            to,
                            file: addition.files[0],
                            displayText: addition.originText,
                        });
                    }
                }
            });
        }

        return builder.finish();
    }
}

const pluginSpec: PluginSpec<AutoLinkerPlugin> = {
    decorations: (value: AutoLinkerPlugin) => value.decorations,
};

export const liveLinkerPlugin = (app: App, settings: LinkerPluginSettings, updateManager: ExternalUpdateManager) => {
    return ViewPlugin.define((editorView: EditorView) => {
        return new AutoLinkerPlugin(editorView, app, settings, updateManager);
    }, pluginSpec);
};
