import { App, EditorPosition, MarkdownView, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';

import { liveLinkerPlugin } from './linker/liveLinker';
import { ExternalUpdateManager, LinkerCache } from 'linker/linkerCache';
import { buildRealLinkReplacement, LinkerMetaInfoFetcher } from 'linker/linkerInfo';

export interface LinkerPluginSettings {
    advancedSettings: boolean;
    linkerActivated: boolean;
    suppressSuffixForSubWords: boolean;
    matchAnyPartsOfWords: boolean;
    matchEndOfWords: boolean;
    matchBeginningOfWords: boolean;
    includeAllFiles: boolean;
    linkerDirectories: string[];
    excludedDirectories: string[];
    excludedDirectoriesForLinking: string[];
    virtualLinkSuffix: string;
    virtualLinkAliasSuffix: string;
    useDefaultLinkStyleForConversion: boolean;
    defaultUseMarkdownLinks: boolean; // Otherwise wiki links
    defaultLinkFormat: 'shortest' | 'relative' | 'absolute';
    useMarkdownLinks: boolean;
    linkFormat: 'shortest' | 'relative' | 'absolute';
    applyDefaultLinkStyling: boolean;
    includeHeaders: boolean;
    matchCaseSensitive: boolean;
    capitalLetterProportionForAutomaticMatchCase: number;
    tagToIgnoreCase: string;
    tagToMatchCase: string;
    propertyNameToMatchCase: string;
    propertyNameToIgnoreCase: string;
    tagToExcludeFile: string;
    tagToIncludeFile: string;
    excludeLinksToOwnNote: boolean;
    fixIMEProblem: boolean;
    excludeLinksInCurrentLine: boolean;
    onlyLinkOnce: boolean;
    excludeLinksToRealLinkedFiles: boolean;
    includeAliases: boolean;
    minimumLinkLength: number;
    alwaysShowMultipleReferences: boolean;
    autoLinkOnEdit: boolean;
    autoLinkDebounceMs: number;
    /** Vault-relative path to a markdown file containing words to exclude from auto-linking, one per line. */
    excludedWordsFile: string;
    /** Cached, derived from excludedWordsFile. Re-loaded on plugin load and on file modify. */
    excludedWords: string[];
    // wordBoundaryRegex: string;
    // conversionFormat
}

const DEFAULT_SETTINGS: LinkerPluginSettings = {
    advancedSettings: false,
    linkerActivated: true,
    matchAnyPartsOfWords: false,
    matchEndOfWords: true,
    matchBeginningOfWords: true,
    suppressSuffixForSubWords: false,
    includeAllFiles: true,
    linkerDirectories: ['Glossary'],
    excludedDirectories: [],
    excludedDirectoriesForLinking: [],
    virtualLinkSuffix: '🔗',
    virtualLinkAliasSuffix: '🔗',
    useMarkdownLinks: false,
    linkFormat: 'shortest',
    defaultUseMarkdownLinks: false,
    defaultLinkFormat: 'shortest',
    useDefaultLinkStyleForConversion: true,
    applyDefaultLinkStyling: true,
    includeHeaders: true,
    matchCaseSensitive: false,
    // > 1.0 disables auto-case-sensitivity entirely (all names match case-insensitively).
    capitalLetterProportionForAutomaticMatchCase: 1.01,
    tagToIgnoreCase: 'linker-ignore-case',
    tagToMatchCase: 'linker-match-case',
    propertyNameToMatchCase: 'linker-match-case',
    propertyNameToIgnoreCase: 'linker-ignore-case',
    tagToExcludeFile: 'linker-exclude',
    tagToIncludeFile: 'linker-include',
    excludeLinksToOwnNote: true,
    fixIMEProblem: false,
    excludeLinksInCurrentLine: false,
    onlyLinkOnce: false,
    // Keep linking even if the file is already linked elsewhere in the note —
    // otherwise only the first occurrence becomes a real link.
    excludeLinksToRealLinkedFiles: false,
    includeAliases: true,
    minimumLinkLength: 2,
    alwaysShowMultipleReferences: false,
    autoLinkOnEdit: true,
    autoLinkDebounceMs: 300,
    excludedWordsFile: 'linker-exclude.md',
    excludedWords: [],
    // wordBoundaryRegex: '/[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u',
};

export default class LinkerPlugin extends Plugin {
    settings: LinkerPluginSettings;
    updateManager = new ExternalUpdateManager();

    async onload() {
        await this.loadSettings();

        // Set callback to update the cache when the settings are changed
        this.updateManager.registerCallback(() => {
            LinkerCache.getInstance(this.app, this.settings).clearCache();
        });

        // Register the live linker for the live edit mode.
        // (Virtual link rendering is disabled; this extension only collects auto-link
        // candidates and converts them to real links on a debounce.)
        this.registerEditorExtension(liveLinkerPlugin(this.app, this.settings, this.updateManager));

        // Load the excluded-words file once layout is ready (the metadata cache
        // is needed to resolve the file path correctly).
        this.app.workspace.onLayoutReady(() => {
            this.reloadExcludedWords();
        });

        // Re-parse the excluded-words file whenever it changes (also handle
        // creation/rename/deletion so the user can manage the file naturally).
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                if (file instanceof TFile && file.path === this.settings.excludedWordsFile) {
                    this.reloadExcludedWords();
                }
            }),
        );
        this.registerEvent(
            this.app.vault.on('create', (file) => {
                if (file instanceof TFile && file.path === this.settings.excludedWordsFile) {
                    this.reloadExcludedWords();
                }
            }),
        );
        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                if (file instanceof TFile && file.path === this.settings.excludedWordsFile) {
                    this.reloadExcludedWords();
                }
            }),
        );
        this.registerEvent(
            this.app.vault.on('rename', (file, oldPath) => {
                if (oldPath === this.settings.excludedWordsFile || (file instanceof TFile && file.path === this.settings.excludedWordsFile)) {
                    this.reloadExcludedWords();
                }
            }),
        );

        // This adds a settings tab so the user can configure various aspects of the plugin
        this.addSettingTab(new LinkerSettingTab(this.app, this));

        // Context menu item to convert virtual links to real links
        this.registerEvent(this.app.workspace.on('file-menu', (menu, file, source) => this.addContextMenuItem(menu, file, source)));

        this.addCommand({
            id: 'activate-virtual-linker',
            name: 'Activate Virtual Linker',
            checkCallback: (checking) => {
                if (!this.settings.linkerActivated) {
                    if (!checking) {
                        this.updateSettings({ linkerActivated: true });
                        this.updateManager.update();
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'deactivate-virtual-linker',
            name: 'Deactivate Virtual Linker',
            checkCallback: (checking) => {
                if (this.settings.linkerActivated) {
                    if (!checking) {
                        this.updateSettings({ linkerActivated: false });
                        this.updateManager.update();
                    }
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'open-excluded-words-file',
            name: 'Open Excluded Words File',
            callback: () => {
                this.openOrCreateExcludedWordsFile();
            },
        });

        this.addCommand({
            id: 'convert-wiki-links-to-text',
            name: 'Convert Wiki Links in Current Note to Plain Text…',
            editorCallback: (editor) => {
                const text = editor.getValue();
                const links = findWikiLinks(text);
                if (links.length === 0) {
                    new Notice('No wiki links found in the current note.');
                    return;
                }
                new WikiLinkRevertModal(this.app, links, text, (selectedIndices) => {
                    if (selectedIndices.length === 0) return;
                    // Apply in reverse offset order so earlier offsets remain valid.
                    const targets = selectedIndices
                        .map((i) => links[i])
                        .sort((a, b) => b.start - a.start);
                    for (const link of targets) {
                        const fromPos = editor.offsetToPos(link.start);
                        const toPos = editor.offsetToPos(link.end);
                        editor.replaceRange(link.replacement, fromPos, toPos);
                    }
                }).open();
            },
        });

        this.addCommand({
            id: 'convert-selected-virtual-links',
            name: 'Convert All Virtual Links in Selection to Real Links',
            checkCallback: (checking: boolean) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                const editor = view?.editor;

                if (!editor || !editor.somethingSelected()) {
                    return false;
                }

                if (checking) return true;

                // Get the selected text range
                const from = editor.getCursor('from');
                const to = editor.getCursor('to');

                // Get the DOM element containing the selection
                const cmEditor = (editor as any).cm;
                if (!cmEditor) return false;

                const selectionRange = cmEditor.dom.querySelector('.cm-content');
                if (!selectionRange) return false;

                // Find all virtual links in the selection
                const virtualLinks = Array.from(selectionRange.querySelectorAll('.virtual-link-a'))
                    .filter((link): link is HTMLElement => link instanceof HTMLElement)
                    .map(link => ({
                        element: link,
                        from: parseInt(link.getAttribute('from') || '-1'),
                        to: parseInt(link.getAttribute('to') || '-1'),
                        text: link.getAttribute('origin-text') || '',
                        href: link.getAttribute('href') || ''
                    }))
                    .filter(link => {
                        const linkFrom = editor.offsetToPos(link.from);
                        const linkTo = editor.offsetToPos(link.to);
                        return this.isPosWithinRange(linkFrom, linkTo, from, to);
                    })
                    .sort((a, b) => a.from - b.from);

                if (virtualLinks.length === 0) return;

                // Process all links in a single operation
                const replacements: {from: number, to: number, text: string}[] = [];

                for (const link of virtualLinks) {
                    const targetFile = this.app.vault.getAbstractFileByPath(link.href);
                    if (!(targetFile instanceof TFile)) continue;

                    const activeFilePath = this.app.workspace.getActiveFile()?.path ?? '';
                    const replacement = buildRealLinkReplacement(
                        this.app,
                        this.settings,
                        targetFile,
                        link.text,
                        activeFilePath,
                    );

                    replacements.push({
                        from: link.from,
                        to: link.to,
                        text: replacement,
                    });
                }

                // Apply all replacements in reverse order to maintain correct positions
                for (const replacement of replacements.reverse()) {
                    const fromPos = editor.offsetToPos(replacement.from);
                    const toPos = editor.offsetToPos(replacement.to);
                    editor.replaceRange(replacement.text, fromPos, toPos);
                }
            }
        });

    }

    private isPosWithinRange(
        linkFrom: EditorPosition,
        linkTo: EditorPosition,
        selectionFrom: EditorPosition,
        selectionTo: EditorPosition
    ): boolean {
        return (
            (linkFrom.line > selectionFrom.line ||
             (linkFrom.line === selectionFrom.line && linkFrom.ch >= selectionFrom.ch)) &&
            (linkTo.line < selectionTo.line ||
             (linkTo.line === selectionTo.line && linkTo.ch <= selectionTo.ch))
        );
    }

    addContextMenuItem(menu: Menu, file: TAbstractFile, source: string) {
        // addContextMenuItem(a: any, b: any, c: any) {
        // Capture the MouseEvent when the context menu is triggered   // Define a named function to capture the MouseEvent

        if (!file) {
            return;
        }

        // console.log('Context menu', menu, file, source);

        const that = this;
        const app: App = this.app;
        const updateManager = this.updateManager;
        const settings = this.settings;

        const fetcher = new LinkerMetaInfoFetcher(app, settings);
        // Check, if the file has the linker-included tag

        const isDirectory = app.vault.getAbstractFileByPath(file.path) instanceof TFolder;

        if (!isDirectory) {
            const metaInfo = fetcher.getMetaInfo(file);

            function contextMenuHandler(event: MouseEvent) {
                // Access the element that triggered the context menu
                const targetElement = event.target;

                if (!targetElement || !(targetElement instanceof HTMLElement)) {
                    console.error('No target element');
                    return;
                }

                // Check, if we are clicking on a virtual link inside a note or a note in the file explorer
                const isVirtualLink = targetElement.classList.contains('virtual-link-a');

                const from = parseInt(targetElement.getAttribute('from') || '-1');
                const to = parseInt(targetElement.getAttribute('to') || '-1');

                if (from === -1 || to === -1) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle(
                            '[Virtual Linker] Converting link is not here.'
                        ).setIcon('link');
                    });
                }
                // Check, if the element has the "virtual-link" class
                else if (isVirtualLink) {
                    menu.addItem((item) => {
                        // Item to convert a virtual link to a real link
                        item.setTitle('[Virtual Linker] Convert to real link')
                            .setIcon('link')
                            .onClick(() => {
                                // Get from and to position from the element
                                const from = parseInt(targetElement.getAttribute('from') || '-1');
                                const to = parseInt(targetElement.getAttribute('to') || '-1');

                                if (from === -1 || to === -1) {
                                    console.error('No from or to position');
                                    return;
                                }

                                // Get the shown text
                                const text = targetElement.getAttribute('origin-text') || '';
                                const activeFile = app.workspace.getActiveFile();

                                if (!activeFile) {
                                    console.error('No active file');
                                    return;
                                }

                                const replacement = buildRealLinkReplacement(
                                    app,
                                    settings,
                                    file as TFile,
                                    text,
                                    activeFile.path,
                                );

                                // Replace the text
                                const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
                                const fromEditorPos = editor?.offsetToPos(from);
                                const toEditorPos = editor?.offsetToPos(to);

                                if (!fromEditorPos || !toEditorPos) {
                                    console.warn('No editor positions');
                                    return;
                                }

                                editor?.replaceRange(replacement, fromEditorPos, toEditorPos);
                            });
                    });
                }

                // Remove the listener to prevent multiple triggers
                document.removeEventListener('contextmenu', contextMenuHandler);
            }

            if (!metaInfo.excludeFile && (metaInfo.includeAllFiles || metaInfo.includeFile || metaInfo.isInIncludedDir)) {
                // Item to exclude a virtual link from the linker
                // This action adds the settings.tagToExcludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('[Virtual Linker] Exclude this file')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                console.error('No target file');
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToExcludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove include tag if it exists
                                    const includeTag = settings.tagToIncludeFile;
                                    if (frontMatter.tags.has(includeTag)) {
                                        frontMatter.tags.delete(includeTag);
                                    }
                                });

                                updateManager.update();
                            }
                        });
                });
            } else if (!metaInfo.includeFile && (!metaInfo.includeAllFiles || metaInfo.excludeFile || metaInfo.isInExcludedDir)) {
                //Item to include a virtual link from the linker
                // This action adds the settings.tagToIncludeFile to the file
                menu.addItem((item) => {
                    item.setTitle('[Virtual Linker] Include this file')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFile = app.vault.getFileByPath(target.path);

                            if (!targetFile) {
                                console.error('No target file');
                                return;
                            }

                            // Add the tag to the file
                            const fileCache = app.metadataCache.getFileCache(targetFile);
                            const frontmatter = fileCache?.frontmatter || {};

                            const tag = settings.tagToIncludeFile;
                            let tags = frontmatter['tags'];

                            if (typeof tags === 'string') {
                                tags = [tags];
                            }

                            if (!Array.isArray(tags)) {
                                tags = [];
                            }

                            if (!tags.includes(tag)) {
                                await app.fileManager.processFrontMatter(targetFile, (frontMatter) => {
                                    if (!frontMatter.tags) {
                                        frontMatter.tags = new Set();
                                    }
                                    const currentTags = [...frontMatter.tags];

                                    frontMatter.tags = new Set([...currentTags, tag]);

                                    // Remove exclude tag if it exists
                                    const excludeTag = settings.tagToExcludeFile;
                                    if (frontMatter.tags.has(excludeTag)) {
                                        frontMatter.tags.delete(excludeTag);
                                    }
                                });

                                updateManager.update();
                            }
                        });
                });
            }

            // Capture the MouseEvent when the context menu is triggered
            document.addEventListener('contextmenu', contextMenuHandler, { once: true });
        } else {
            // Check if the directory is in the linker directories
            const path = file.path + '/';
            const isInIncludedDir = fetcher.includeDirPattern.test(path);
            const isInExcludedDir = fetcher.excludeDirPattern.test(path);

            // If the directory is in the linker directories, add the option to exclude it
            if ((fetcher.includeAllFiles && !isInExcludedDir) || isInIncludedDir) {
                menu.addItem((item) => {
                    item.setTitle('[Virtual Linker] Exclude this directory')
                        .setIcon('trash')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path) as TFolder;

                            if (!targetFolder) {
                                console.error('No target folder');
                                return;
                            }

                            const newExcludedDirs = Array.from(new Set([...settings.excludedDirectories, targetFolder.name]));
                            const newIncludedDirs = settings.linkerDirectories.filter((dir) => dir !== targetFolder.name);
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs });

                            updateManager.update();
                        });
                });
            } else if ((!fetcher.includeAllFiles && !isInIncludedDir) || isInExcludedDir) {
                // If the directory is in the excluded directories, add the option to include it
                menu.addItem((item) => {
                    item.setTitle('[Virtual Linker] Include this directory')
                        .setIcon('plus')
                        .onClick(async () => {
                            // Get the shown text
                            const target = file;

                            // Get the file
                            const targetFolder = app.vault.getAbstractFileByPath(target.path) as TFolder;

                            if (!targetFolder) {
                                console.error('No target folder');
                                return;
                            }

                            const newExcludedDirs = settings.excludedDirectories.filter((dir) => dir !== targetFolder.name);
                            const newIncludedDirs = Array.from(new Set([...settings.linkerDirectories, targetFolder.name]));
                            await this.updateSettings({ linkerDirectories: newIncludedDirs, excludedDirectories: newExcludedDirs });

                            updateManager.update();
                        });
                });
            }
        }
    }

    onunload() {}

    /**
     * Read the excluded-words file from the vault and update settings.excludedWords.
     * Format: one word per line. Leading "- " or "* " bullets are stripped.
     * Lines starting with "#" are ignored (comments / markdown headers).
     * Empty lines and YAML frontmatter are ignored.
     */
    async reloadExcludedWords() {
        const path = this.settings.excludedWordsFile?.trim();
        if (!path) {
            if ((this.settings.excludedWords ?? []).length > 0) {
                this.settings.excludedWords = [];
                await this.saveData(this.settings);
                this.updateManager.update();
            }
            return;
        }

        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) {
            // File missing — clear the list (so removing the file disables exclusions).
            if ((this.settings.excludedWords ?? []).length > 0) {
                this.settings.excludedWords = [];
                await this.saveData(this.settings);
                this.updateManager.update();
            }
            return;
        }

        const raw = await this.app.vault.cachedRead(file);
        const words = parseExcludedWords(raw);

        // Avoid spurious cache invalidation if the list is unchanged.
        const prev = this.settings.excludedWords ?? [];
        if (prev.length === words.length && prev.every((w, i) => w === words[i])) return;

        this.settings.excludedWords = words;
        await this.saveData(this.settings);
        this.updateManager.update();
    }

    async openOrCreateExcludedWordsFile() {
        const path = this.settings.excludedWordsFile?.trim();
        if (!path) return;

        let file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
            const initial = '# Words to exclude from auto-linking, one per line.\n';
            file = await this.app.vault.create(path, initial);
        }
        if (file instanceof TFile) {
            await this.app.workspace.getLeaf(true).openFile(file);
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Load markdown links from obsidian settings
        // At the moment obsidian does not provide a clean way to get the settings through an API
        // So we read the app.json settings file directly
        // We also Cannot use the vault API because it only reads the vault files not the .obsidian folder
        const fileContent = await this.app.vault.adapter.read(this.app.vault.configDir + '/app.json');
        const appSettings = JSON.parse(fileContent);
        this.settings.defaultUseMarkdownLinks = appSettings.useMarkdownLinks;
        this.settings.defaultLinkFormat = appSettings.newLinkFormat ?? 'shortest';
    }

    /** Update plugin settings. */
    async updateSettings(settings: Partial<LinkerPluginSettings> = <Partial<LinkerPluginSettings>>{}) {
        Object.assign(this.settings, settings);
        await this.saveData(this.settings);
        this.updateManager.update();
    }
}

/**
 * Modal that lists every wiki link found in the current note and lets the user
 * pick which to revert to plain text.
 */
class WikiLinkRevertModal extends Modal {
    constructor(
        app: App,
        private links: WikiLinkMatch[],
        private docText: string,
        private onSubmit: (selectedIndices: number[]) => void,
    ) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.createEl('h3', { text: 'Convert wiki links to plain text' });

        // Group links by their replacement word (the displayed text).
        const groups = new Map<string, number[]>();
        this.links.forEach((link, i) => {
            const arr = groups.get(link.replacement) ?? [];
            arr.push(i);
            groups.set(link.replacement, arr);
        });
        const words = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b));

        contentEl.createEl('p', {
            text: `${this.links.length} link(s) across ${words.length} word(s). Choose words to revert:`,
        });

        // Filter input.
        const filterWrap = contentEl.createDiv();
        filterWrap.style.margin = '8px 0';
        const filterInput = filterWrap.createEl('input', { type: 'text' });
        filterInput.placeholder = 'Filter words…';
        filterInput.style.width = '100%';
        filterInput.style.padding = '4px 8px';

        const checked = new Map<string, boolean>();
        for (const w of words) checked.set(w, true);

        // Word list.
        const list = contentEl.createDiv();
        list.style.maxHeight = '50vh';
        list.style.overflowY = 'auto';
        list.style.margin = '8px 0';
        list.style.borderTop = '1px solid var(--background-modifier-border)';
        list.style.borderBottom = '1px solid var(--background-modifier-border)';

        const rows = new Map<string, { row: HTMLElement; cb: HTMLInputElement }>();
        for (const word of words) {
            const indices = groups.get(word)!;
            const row = list.createDiv();
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.gap = '8px';
            row.style.padding = '4px 2px';
            row.style.cursor = 'pointer';

            const cb = row.createEl('input', { type: 'checkbox' });
            cb.checked = true;
            cb.addEventListener('change', () => checked.set(word, cb.checked));

            const label = row.createSpan();
            label.style.flex = '1';
            label.style.whiteSpace = 'nowrap';
            label.style.overflow = 'hidden';
            label.style.textOverflow = 'ellipsis';
            label.createEl('strong', { text: word });
            const countEl = label.createSpan({ text: `  (${indices.length})` });
            countEl.style.opacity = '0.6';
            countEl.style.fontSize = '0.85em';

            // Tooltip: first occurrence's context.
            const first = this.links[indices[0]];
            const ctxStart = Math.max(0, first.start - 30);
            const ctxEnd = Math.min(this.docText.length, first.end + 30);
            const ctx = this.docText.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ');
            row.title = `${first.raw}\n…${ctx}…`;

            row.addEventListener('click', (ev) => {
                if (ev.target === cb) return;
                cb.checked = !cb.checked;
                checked.set(word, cb.checked);
            });

            rows.set(word, { row, cb });
        }

        const visibleWords = (): string[] =>
            words.filter((w) => rows.get(w)!.row.style.display !== 'none');

        filterInput.addEventListener('input', () => {
            const q = filterInput.value.trim().toLowerCase();
            for (const word of words) {
                const visible = q.length === 0 || word.toLowerCase().includes(q);
                rows.get(word)!.row.style.display = visible ? 'flex' : 'none';
            }
        });

        // Footer with counts and buttons.
        const controls = contentEl.createDiv();
        controls.style.display = 'flex';
        controls.style.gap = '8px';
        controls.style.marginTop = '12px';
        controls.style.justifyContent = 'flex-end';
        controls.style.flexWrap = 'wrap';

        const setVisible = (value: boolean) => {
            for (const word of visibleWords()) {
                checked.set(word, value);
                rows.get(word)!.cb.checked = value;
            }
        };

        controls.createEl('button', { text: 'Select all (visible)' })
            .addEventListener('click', () => setVisible(true));
        controls.createEl('button', { text: 'Deselect all (visible)' })
            .addEventListener('click', () => setVisible(false));
        controls.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
        const okBtn = controls.createEl('button', { text: 'Convert', cls: 'mod-cta' });
        okBtn.addEventListener('click', () => {
            const selectedIndices: number[] = [];
            for (const word of words) {
                if (checked.get(word)) selectedIndices.push(...groups.get(word)!);
            }
            this.close();
            this.onSubmit(selectedIndices);
        });

        // Focus the filter for instant typing.
        setTimeout(() => filterInput.focus(), 0);
    }

    onClose() {
        this.contentEl.empty();
    }
}

export interface WikiLinkMatch {
    /** Start offset (inclusive) of the `[[` in the source text. */
    start: number;
    /** End offset (exclusive) of the `]]` in the source text. */
    end: number;
    /** The full matched substring, e.g. `[[Note|alias]]`. */
    raw: string;
    /** The replacement plain text (alias if present, otherwise the inner content). */
    replacement: string;
}

/**
 * Locate wiki-style links `[[xxxx]]` in `text`.
 * - `[[Note]]` → `Note`
 * - `[[Note|alias]]` → `alias` (the displayed text wins)
 * - `[[Note#Heading]]` → `Note#Heading`
 * - `![[Note]]` (embeds) are skipped.
 */
export function findWikiLinks(text: string): WikiLinkMatch[] {
    const re = /(?<!!)\[\[([^\[\]\n]+)\]\]/g;
    const out: WikiLinkMatch[] = [];
    for (const m of text.matchAll(re)) {
        const start = m.index!;
        const end = start + m[0].length;
        const inner = m[1];
        const pipeIdx = inner.indexOf('|');
        const replacement = pipeIdx === -1 ? inner : inner.slice(pipeIdx + 1);
        out.push({ start, end, raw: m[0], replacement });
    }
    return out;
}

/**
 * Parse the contents of the excluded-words file.
 * - Strips YAML frontmatter at the top of the file.
 * - Treats lines starting with `#` as comments (also covers markdown headers).
 * - Strips leading list bullets (`- `, `* `, `+ `).
 * - Trims and filters empty lines.
 * - Deduplicates while preserving order.
 */
export function parseExcludedWords(raw: string): string[] {
    let body = raw;

    // Strip YAML frontmatter if present.
    if (body.startsWith('---\n')) {
        const end = body.indexOf('\n---', 4);
        if (end !== -1) {
            body = body.slice(end + 4);
        }
    }

    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of body.split('\n')) {
        const stripped = line.replace(/^\s*[-*+]\s+/, '').trim();
        if (!stripped) continue;
        if (stripped.startsWith('#')) continue;
        const key = stripped.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(stripped);
    }
    return result;
}

class LinkerSettingTab extends PluginSettingTab {
    constructor(app: App, public plugin: LinkerPlugin) {
        super(app, plugin);
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        // Toggle to activate or deactivate the linker
        new Setting(containerEl).setName('Activate Virtual Linker').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.linkerActivated).onChange(async (value) => {
                // console.log("Linker activated: " + value);
                await this.plugin.updateSettings({ linkerActivated: value });
            })
        );

        // Toggle to show advanced settings
        new Setting(containerEl).setName('Show advanced settings').addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.advancedSettings).onChange(async (value) => {
                // console.log("Advanced settings: " + value);
                await this.plugin.updateSettings({ advancedSettings: value });
                this.display();
            })
        );

        new Setting(containerEl).setName('Auto-link').setHeading();

        // Toggle to enable automatic real-link insertion while editing
        new Setting(containerEl)
            .setName('Auto-insert real links while editing')
            .setDesc(
                'If activated, matched terms outside the current line are automatically replaced with real wiki/markdown links after you stop typing. The current line is left untouched (IME-safe).'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoLinkOnEdit).onChange(async (value) => {
                    await this.plugin.updateSettings({ autoLinkOnEdit: value });
                    this.display();
                })
            );

        if (this.plugin.settings.autoLinkOnEdit && this.plugin.settings.advancedSettings) {
            new Setting(containerEl)
                .setName('Auto-link debounce (ms)')
                .setDesc('Idle time after typing before auto-linking runs. Larger values are safer with IME but feel less responsive.')
                .addText((text) =>
                    text
                        .setValue(String(this.plugin.settings.autoLinkDebounceMs))
                        .onChange(async (value) => {
                            let newValue = parseInt(value, 10);
                            if (isNaN(newValue) || newValue < 100) {
                                newValue = 100;
                            } else if (newValue > 10000) {
                                newValue = 10000;
                            }
                            await this.plugin.updateSettings({ autoLinkDebounceMs: newValue });
                        })
                );
        }

        if (this.plugin.settings.autoLinkOnEdit) {
            const wordCount = (this.plugin.settings.excludedWords ?? []).length;
            new Setting(containerEl)
                .setName('Excluded words file')
                .setDesc(
                    `Vault-relative path to a markdown file listing words/phrases to never auto-link. One per line. Case-insensitive. Lines starting with "#" or "-" are treated as comments / list bullets and stripped. Currently loaded: ${wordCount} word(s).`
                )
                .addText((text) =>
                    text
                        .setPlaceholder('linker-exclude.md')
                        .setValue(this.plugin.settings.excludedWordsFile)
                        .onChange(async (value) => {
                            await this.plugin.updateSettings({ excludedWordsFile: value.trim() });
                            await this.plugin.reloadExcludedWords();
                            this.display();
                        })
                )
                .addExtraButton((btn) =>
                    btn
                        .setIcon('file-plus')
                        .setTooltip('Open or create the exclude file')
                        .onClick(async () => {
                            await this.plugin.openOrCreateExcludedWordsFile();
                        })
                );
        }

        new Setting(containerEl).setName('Matching behavior').setHeading();

        // Toggle to include aliases
        new Setting(containerEl)
            .setName('Include aliases')
            .setDesc('If activated, the virtual linker will also include aliases for the files.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeAliases).onChange(async (value) => {
                    // console.log("Include aliases: " + value);
                    await this.plugin.updateSettings({ includeAliases: value });
                })
            );

        // Number input for minimum link length
        new Setting(containerEl)
            .setName('Minimum link length')
            .setDesc('Minimum number of characters a note title or alias must have to be linked automatically.')
            .addText((text) =>
                text
                    .setValue(String(this.plugin.settings.minimumLinkLength))
                    .onChange(async (value) => {
                        let newValue = parseInt(value, 10);
                        if (isNaN(newValue) || newValue < 1) {
                            newValue = 1;
                        }
                        await this.plugin.updateSettings({ minimumLinkLength: newValue });
                    })
            );

        if (this.plugin.settings.advancedSettings) {
            // Toggle to only link once
            new Setting(containerEl)
                .setName('Only link once')
                .setDesc('If activated, there will not be several identical virtual links in the same note (Wikipedia style).')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.onlyLinkOnce).onChange(async (value) => {
                        // console.log("Only link once: " + value);
                        await this.plugin.updateSettings({ onlyLinkOnce: value });
                    })
                );

            // Toggle to exclude links to real linked files
            new Setting(containerEl)
                .setName('Exclude links to real linked files')
                .setDesc('If activated, there will be no links to files that are already linked in the note by real links.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToRealLinkedFiles).onChange(async (value) => {
                        // console.log("Exclude links to real linked files: " + value);
                        await this.plugin.updateSettings({ excludeLinksToRealLinkedFiles: value });
                    })
                );
        }

        // If headers should be matched or not
        new Setting(containerEl)
            .setName('Include headers')
            .setDesc('If activated, headers (so your lines beginning with at least one `#`) are included for virtual links.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeHeaders).onChange(async (value) => {
                    // console.log("Include headers: " + value);
                    await this.plugin.updateSettings({ includeHeaders: value });
                })
            );

        // Toggle setting to match only whole words or any part of the word
        new Setting(containerEl)
            .setName('Match any part of a word')
            .setDesc('If deactivated, only whole words are matched. Otherwise, every part of a word is found.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchAnyPartsOfWords).onChange(async (value) => {
                    // console.log("Match only whole words: " + value);
                    await this.plugin.updateSettings({ matchAnyPartsOfWords: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.matchAnyPartsOfWords) {
            // Toggle setting to match only beginning of words
            new Setting(containerEl)
                .setName('Match the beginning of words')
                .setDesc('If activated, the beginnings of words are also linked, even if it is not a whole match.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchBeginningOfWords).onChange(async (value) => {
                        // console.log("Match only beginning of words: " + value);
                        await this.plugin.updateSettings({ matchBeginningOfWords: value });
                        this.display();
                    })
                );

            // Toggle setting to match only end of words
            new Setting(containerEl)
                .setName('Match the end of words')
                .setDesc('If activated, the ends of words are also linked, even if it is not a whole match.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.matchEndOfWords).onChange(async (value) => {
                        // console.log("Match only end of words: " + value);
                        await this.plugin.updateSettings({ matchEndOfWords: value });
                        this.display();
                    })
                );
        }

        // Toggle setting to suppress suffix for sub words
        if (this.plugin.settings.matchAnyPartsOfWords || this.plugin.settings.matchBeginningOfWords) {
            new Setting(containerEl)
                .setName('Suppress suffix for sub words')
                .setDesc('If activated, the suffix is not added to links for subwords, but only for complete matches.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.suppressSuffixForSubWords).onChange(async (value) => {
                        // console.log("Suppress suffix for sub words: " + value);
                        await this.plugin.updateSettings({ suppressSuffixForSubWords: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line start for fixing IME
            new Setting(containerEl)
                .setName('Fix IME problem')
                .setDesc(
                    'If activated, there will be no links in the current line start which is followed immediately by the Input Method Editor (IME). This is the recommended setting if you are using IME (input method editor) for typing, e.g. for chinese characters, because instant linking might interfere with IME.'
                )
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.fixIMEProblem).onChange(async (value) => {
                        // console.log("Exclude links in current line: " + value);
                        await this.plugin.updateSettings({ fixIMEProblem: value });
                    })
                );
        }

        if (this.plugin.settings.advancedSettings) {
            // Toggle setting to exclude links in the current line
            new Setting(containerEl)
                .setName('Avoid linking in current line')
                .setDesc('If activated, there will be no links in the current line.')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksInCurrentLine).onChange(async (value) => {
                        // console.log("Exclude links in current line: " + value);
                        await this.plugin.updateSettings({ excludeLinksInCurrentLine: value });
                    })
                );

            // Input for setting the word boundary regex
            // new Setting(containerEl)
            // 	.setName('Word boundary regex')
            // 	.setDesc('The regex for the word boundary. This regex is used to find the beginning and end of a word. It is used to find the boundaries of the words to match. Defaults to /[\t- !-/:-@\[-`{-~\p{Emoji_Presentation}\p{Extended_Pictographic}]/u to catch most word boundaries.')
            // 	.addText((text) =>
            // 		text
            // 			.setValue(this.plugin.settings.wordBoundaryRegex)
            // 			.onChange(async (value) => {
            // 				try {
            // 					await this.plugin.updateSettings({ wordBoundaryRegex: value });
            // 				} catch (e) {
            // 					console.error('Invalid regex', e);
            // 				}
            // 			})
            // 	);
        }

        new Setting(containerEl).setName('Case sensitivity').setHeading();

        // Toggle setting for case sensitivity
        new Setting(containerEl)
            .setName('Case sensitive')
            .setDesc('If activated, the matching is case sensitive.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.matchCaseSensitive).onChange(async (value) => {
                    // console.log("Case sensitive: " + value);
                    await this.plugin.updateSettings({ matchCaseSensitive: value });
                    this.display();
                })
            );

        if (this.plugin.settings.advancedSettings) {
            // Number input setting for capital letter proportion for automatic match case
            new Setting(containerEl)
                .setName('Capital letter percentage for automatic match case')
                .setDesc(
                    'The percentage (0 - 100) of capital letters in a file name or alias to be automatically considered as case sensitive.'
                )
                .addText((text) =>
                    text
                        .setValue((this.plugin.settings.capitalLetterProportionForAutomaticMatchCase * 100).toFixed(1))
                        .onChange(async (value) => {
                            let newValue = parseFloat(value);
                            if (isNaN(newValue)) {
                                newValue = 75;
                            } else if (newValue < 0) {
                                newValue = 0;
                            } else if (newValue > 100) {
                                newValue = 100;
                            }
                            newValue /= 100;

                            // console.log("New capital letter proportion for automatic match case: " + newValue);
                            await this.plugin.updateSettings({ capitalLetterProportionForAutomaticMatchCase: newValue });
                        })
                );

            if (this.plugin.settings.matchCaseSensitive) {
                // Text setting for tag to ignore case
                new Setting(containerEl)
                    .setName('Tag to ignore case')
                    .setDesc('By adding this tag to a file, the linker will ignore the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToIgnoreCase).onChange(async (value) => {
                            // console.log("New tag to ignore case: " + value);
                            await this.plugin.updateSettings({ tagToIgnoreCase: value });
                        })
                    );
            } else {
                // Text setting for tag to match case
                new Setting(containerEl)
                    .setName('Tag to match case')
                    .setDesc('By adding this tag to a file, the linker will match the case for the file.')
                    .addText((text) =>
                        text.setValue(this.plugin.settings.tagToMatchCase).onChange(async (value) => {
                            // console.log("New tag to match case: " + value);
                            await this.plugin.updateSettings({ tagToMatchCase: value });
                        })
                    );
            }

            // Text setting for property name to ignore case
            new Setting(containerEl)
                .setName('Property name to ignore case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will ignore the case for the specified names / aliases. This way you can decide, which alias should be insensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToIgnoreCase).onChange(async (value) => {
                        // console.log("New property name to ignore case: " + value);
                        await this.plugin.updateSettings({ propertyNameToIgnoreCase: value });
                    })
                );

            // Text setting for property name to match case
            new Setting(containerEl)
                .setName('Property name to match case')
                .setDesc(
                    'By adding this property to a note, containing a list of names, the linker will match the case for the specified names / aliases. This way you can decide, which alias should be case sensitive.'
                )
                .addText((text) =>
                    text.setValue(this.plugin.settings.propertyNameToMatchCase).onChange(async (value) => {
                        // console.log("New property name to match case: " + value);
                        await this.plugin.updateSettings({ propertyNameToMatchCase: value });
                    })
                );
        }

        new Setting(containerEl).setName('Matched files').setHeading();

        new Setting(containerEl)
            .setName('Include all files')
            .setDesc('Include all files for the virtual linker.')
            .addToggle((toggle) =>
                toggle
                    // .setValue(true)
                    .setValue(this.plugin.settings.includeAllFiles)
                    .onChange(async (value) => {
                        // console.log("Include all files: " + value);
                        await this.plugin.updateSettings({ includeAllFiles: value });
                        this.display();
                    })
            );

        if (!this.plugin.settings.includeAllFiles) {
            new Setting(containerEl)
                .setName('Glossary linker directories')
                .setDesc('Directories to include for the virtual linker (separated by new lines).')
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.linkerDirectories.join('\n');
                    } catch (e) {
                        console.warn(e);
                    }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.linkerDirectories = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            // console.log("New folder name: " + value, this.plugin.settings.linkerDirectories);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });
        } else {
            if (this.plugin.settings.advancedSettings) {
                new Setting(containerEl)
                    .setName('Excluded directories')
                    .setDesc(
                        'Directories from which files are to be excluded for the virtual linker (separated by new lines). Files in these directories will not create any virtual links in other files.'
                    )
                    .addTextArea((text) => {
                        let setValue = '';
                        try {
                            setValue = this.plugin.settings.excludedDirectories.join('\n');
                        } catch (e) {
                            console.warn(e);
                        }

                        text.setPlaceholder('List of directory names (separated by new line)')
                            .setValue(setValue)
                            .onChange(async (value) => {
                                this.plugin.settings.excludedDirectories = value
                                    .split('\n')
                                    .map((x) => x.trim())
                                    .filter((x) => x.length > 0);
                                // console.log("New folder name: " + value, this.plugin.settings.excludedDirectories);
                                await this.plugin.updateSettings();
                            });

                        // Set default size
                        text.inputEl.addClass('linker-settings-text-box');
                    });
            }
        }

        if (this.plugin.settings.advancedSettings) {
            // Text setting for tag to include file
            new Setting(containerEl)
                .setName('Tag to include file')
                .setDesc('Tag to explicitly include the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToIncludeFile).onChange(async (value) => {
                        // console.log("New tag to include file: " + value);
                        await this.plugin.updateSettings({ tagToIncludeFile: value });
                    })
                );

            // Text setting for tag to ignore file
            new Setting(containerEl)
                .setName('Tag to ignore file')
                .setDesc('Tag to ignore the file for the linker.')
                .addText((text) =>
                    text.setValue(this.plugin.settings.tagToExcludeFile).onChange(async (value) => {
                        // console.log("New tag to ignore file: " + value);
                        await this.plugin.updateSettings({ tagToExcludeFile: value });
                    })
                );

            // Toggle setting to exclude links to the active file
            new Setting(containerEl)
                .setName('Exclude self-links to the current note')
                .setDesc('If toggled, links to the note itself are excluded from the linker. (This might not work in preview windows.)')
                .addToggle((toggle) =>
                    toggle.setValue(this.plugin.settings.excludeLinksToOwnNote).onChange(async (value) => {
                        // console.log("Exclude links to active file: " + value);
                        await this.plugin.updateSettings({ excludeLinksToOwnNote: value });
                    })
                );

            // Setting to exclude directories from the linker to be executed
            new Setting(containerEl)
                .setName('Excluded directories for generating virtual links')
                .setDesc('Directories in which the plugin will not create virtual links (separated by new lines).')
                .addTextArea((text) => {
                    let setValue = '';
                    try {
                        setValue = this.plugin.settings.excludedDirectoriesForLinking.join('\n');
                    } catch (e) {
                        console.warn(e);
                    }

                    text.setPlaceholder('List of directory names (separated by new line)')
                        .setValue(setValue)
                        .onChange(async (value) => {
                            this.plugin.settings.excludedDirectoriesForLinking = value
                                .split('\n')
                                .map((x) => x.trim())
                                .filter((x) => x.length > 0);
                            // console.log("New folder name: " + value, this.plugin.settings.excludedDirectoriesForLinking);
                            await this.plugin.updateSettings();
                        });

                    // Set default size
                    text.inputEl.addClass('linker-settings-text-box');
                });
        }

        new Setting(containerEl).setName('Link style').setHeading();

        new Setting(containerEl)
            .setName('Always show multiple references')
            .setDesc('If toggled, if there are multiple matching notes, all references are shown behind the match. If not toggled, the references are only shown if hovering over the match.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.alwaysShowMultipleReferences).onChange(async (value) => {
                    // console.log("Always show multiple references: " + value);
                    await this.plugin.updateSettings({ alwaysShowMultipleReferences: value });
                })
            );

        new Setting(containerEl)
            .setName('Virtual link suffix')
            .setDesc('The suffix to add to auto generated virtual links.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkSuffix).onChange(async (value) => {
                    // console.log("New glossary suffix: " + value);
                    await this.plugin.updateSettings({ virtualLinkSuffix: value });
                })
            );
        new Setting(containerEl)
            .setName('Virtual link suffix for aliases')
            .setDesc('The suffix to add to auto generated virtual links for aliases.')
            .addText((text) =>
                text.setValue(this.plugin.settings.virtualLinkAliasSuffix).onChange(async (value) => {
                    // console.log("New glossary suffix: " + value);
                    await this.plugin.updateSettings({ virtualLinkAliasSuffix: value });
                })
            );

        // Toggle setting to apply default link styling
        new Setting(containerEl)
            .setName('Apply default link styling')
            .setDesc(
                'If toggled, the default link styling will be applied to virtual links. Furthermore, you can style the links yourself with a CSS-snippet affecting the class `virtual-link`. (Find the CSS snippet directory at Appearance -> CSS Snippets -> Open snippets folder)'
            )
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.applyDefaultLinkStyling).onChange(async (value) => {
                    // console.log("Apply default link styling: " + value);
                    await this.plugin.updateSettings({ applyDefaultLinkStyling: value });
                })
            );

        // Toggle setting to use default link style for conversion
        new Setting(containerEl)
            .setName('Use default link style for conversion')
            .setDesc('If toggled, the default link style will be used for the conversion of virtual links to real links.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.useDefaultLinkStyleForConversion).onChange(async (value) => {
                    // console.log("Use default link style for conversion: " + value);
                    await this.plugin.updateSettings({ useDefaultLinkStyleForConversion: value });
                    this.display();
                })
            );

        if (!this.plugin.settings.useDefaultLinkStyleForConversion) {
            // Toggle setting to use markdown links
            new Setting(containerEl)
                .setName('Use [[Wiki-links]]')
                .setDesc('If toggled, the virtual links will be created as wiki-links instead of markdown links.')
                .addToggle((toggle) =>
                    toggle.setValue(!this.plugin.settings.useMarkdownLinks).onChange(async (value) => {
                        // console.log("Use markdown links: " + value);
                        await this.plugin.updateSettings({ useMarkdownLinks: !value });
                    })
                );

            // Dropdown setting for link format
            new Setting(containerEl)
                .setName('Link format')
                .setDesc('The format of the generated links.')
                .addDropdown((dropdown) =>
                    dropdown
                        .addOption('shortest', 'Shortest')
                        .addOption('relative', 'Relative')
                        .addOption('absolute', 'Absolute')
                        .setValue(this.plugin.settings.linkFormat)
                        .onChange(async (value) => {
                            // console.log("New link format: " + value);
                            await this.plugin.updateSettings({ linkFormat: value as 'shortest' | 'relative' | 'absolute' });
                        })
                );
        }
    }
}
