import IntervalTree from '@flatten-js/interval-tree';
import { LinkerPluginSettings } from 'main';
import { TFile } from 'obsidian';

export class VirtualMatch {
    constructor(
        public id: number,
        public originText: string,
        public from: number,
        public to: number,
        public files: TFile[],
        public isAlias: boolean,
        public isSubWord: boolean,
        public settings: LinkerPluginSettings
    ) {}

    /////////////////////////////////////////////////
    // DOM methods
    /////////////////////////////////////////////////

    getCompleteLinkElement() {
        const span = this.getLinkRootSpan();
        const firstPath = this.files.length > 0 ? this.files[0].path: ""; 
        span.appendChild(this.getLinkAnchorElement(this.originText, firstPath));
        if (this.files.length > 1) {
            if (!this.isSubWord) {
                span.appendChild(this.getMultipleReferencesIndicatorSpan());
            }
            span.appendChild(this.getMultipleReferencesSpan());
        }

        if (!this.isSubWord || !this.settings.suppressSuffixForSubWords) {
            const icon = this.getIconSpan();
            if (icon) span.appendChild(icon);
        }
        return span;
    }

    getLinkAnchorElement(linkText: string, href: string) {
        const link = document.createElement('a');
        link.href = href;
        link.textContent = linkText;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('from', this.from.toString());
        link.setAttribute('to', this.to.toString());
        link.setAttribute('origin-text', this.originText);
        link.classList.add('internal-link', 'virtual-link-a');
        return link;
    }

    getLinkRootSpan() {
        const span = document.createElement('span');
        span.classList.add('glossary-entry', 'virtual-link', 'virtual-link-span');
        if (this.settings.applyDefaultLinkStyling) {
            span.classList.add('virtual-link-default');
        }
        return span;
    }

    getMultipleReferencesSpan(files?: TFile[]) {
        const spanReferences = document.createElement('span');
        if (!this.settings.alwaysShowMultipleReferences) {
            spanReferences.classList.add('multiple-files-references');
        }

        files = files ?? this.files;



        files.forEach((file, index) => {
            if (index === 0) {
                const bracket = document.createElement('span');
                bracket.textContent = this.isSubWord ? '[' : ' [';
                spanReferences.appendChild(bracket);
            }

            let linkText = ` ${index + 1} `;
            if (index < files!.length - 1) {
                linkText += '|';
            }

            let linkHref = file.path;
            const link = this.getLinkAnchorElement(linkText, linkHref);
            spanReferences.appendChild(link);

            if (index == files!.length - 1) {
                const bracket = document.createElement('span');
                bracket.textContent = ']';
                spanReferences.appendChild(bracket);
            }
        });

        return spanReferences;
    }

    getMultipleReferencesIndicatorSpan() {
        const spanIndicator = document.createElement('span');
        spanIndicator.textContent = ' [...]';
        spanIndicator.classList.add('multiple-files-indicator');
        return spanIndicator;
    }

    getIconSpan() {
        const suffix = this.isAlias ? this.settings.virtualLinkAliasSuffix : this.settings.virtualLinkSuffix;
        if ((suffix?.length ?? 0) > 0) {
            let icon = document.createElement('sup');
            icon.textContent = suffix;
            icon.classList.add('linker-suffix-icon');
            return icon;
        }
        return null;
    }

    /////////////////////////////////////////////////
    // Filter and sort methods
    /////////////////////////////////////////////////

    static compare(a: VirtualMatch, b: VirtualMatch): number {
        if (a.from === b.from) {
            if (b.to == a.to) {
                return b.files.length - a.files.length;
            }
            return b.to - a.to;
        }
        return a.from - b.from;
    }

    static sort(matches: VirtualMatch[]): VirtualMatch[] {
        return Array.from(matches).sort(VirtualMatch.compare);
    }

    static filterAlreadyLinked(matches: VirtualMatch[], linkedFiles: Set<TFile>, mode: 'some' | 'every' = 'every'): VirtualMatch[] {
        return matches.filter((match) => {
            if (mode === 'every') {
                return !match.files.every((file) => linkedFiles.has(file));
            } else {
                return !match.files.some((file) => linkedFiles.has(file));
            }
        });
    }

    static filterOverlapping(matches: VirtualMatch[], onlyLinkOnce: boolean = true, excludedIntervalTree?: IntervalTree): VirtualMatch[] {
        const matchesToDelete: Map<number, boolean> = new Map();

        // Phase 1: Remove matches inside excluded blocks
        if (excludedIntervalTree) {
            for (const match of matches) {
                const overlaps = excludedIntervalTree.search([match.from, match.to]);
                if (overlaps.length > 0) {
                    matchesToDelete.set(match.id, true);
                }
            }
        }

        // Phase 2: Remove shorter overlapping matches (keep longer ones).
        // Matches are sorted by from asc, then to desc, so the first match at a
        // given position is always the longest — delete everything it overlaps.
        for (let i = 0; i < matches.length; i++) {
            const addition = matches[i];
            if (matchesToDelete.has(addition.id)) continue;

            for (let j = i + 1; j < matches.length; j++) {
                const other = matches[j];
                if (other.from >= addition.to) break;
                matchesToDelete.set(other.id, true);
            }
        }

        // Phase 3: onlyLinkOnce — remove same-file duplicates among survivors only.
        // Must run after phase 2 so that sub-matches of a duplicate are already
        // gone before the duplicate itself is removed.
        if (onlyLinkOnce) {
            const survivors = matches.filter((m) => !matchesToDelete.has(m.id));
            for (let i = 0; i < survivors.length; i++) {
                const addition = survivors[i];
                if (matchesToDelete.has(addition.id)) continue;
                for (let j = i + 1; j < survivors.length; j++) {
                    const other = survivors[j];
                    if (matchesToDelete.has(other.id)) continue;
                    if (other.files.every((f) => addition.files.contains(f))) {
                        matchesToDelete.set(other.id, true);
                    }
                }
            }
        }

        return matches.filter((match) => !matchesToDelete.has(match.id));
    }
}
