/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ServicePlatform } from "@prague/component-runtime";
import { IComponent } from "@prague/container-definitions";
import { Marker } from "@prague/merge-tree";
import { IComponent as ILegacyComponent, IComponentRenderHTML } from "@prague/runtime-definitions";
import * as assert from "assert";
import { DocSegmentKind, getCss, getDocSegmentKind } from "../../document";
import { Tag } from "../../util/tag";
import { debug } from "../debug";
import * as styles from "../index.css";
import { ICssProps, sameCss, syncCss } from "./css";
import { Formatter, IFormatterState } from "./formatter";
import { Layout } from "./layout";

export class DocumentFormatter extends Formatter<IFormatterState> {
    constructor() { super(); }

    public createState(): never { throw new Error(); }
    public begin(): never { throw new Error(); }
    public end(): never { throw new Error(); }

    public visit(state: IFormatterState, layout: Layout) {
        const segment = layout.segment;
        const kind = getDocSegmentKind(segment);

        switch (kind) {
            case DocSegmentKind.text: {
                layout.pushFormat(paragraphFormatter);
                return false;
            }

            case DocSegmentKind.paragraph: {
                layout.pushFormat(paragraphFormatter);
                return true;
            }

            case DocSegmentKind.inclusion: {
                layout.pushFormat(inclusionFormatter);
                return false;
            }

            case DocSegmentKind.beginTags: {
                layout.pushFormat(tagsFormatter);
                return true;
            }

            case DocSegmentKind.endTags: {
                // If the DocumentFormatter encounters an 'endRange', presumably this is because the 'beginTag'
                // has not yet been inserted.  Ignore it.
                assert.strictEqual(layout.doc.getStart(segment as Marker), undefined);
                return true;
            }

            default:
                assert.fail(`Unhandled DocSegmentKind '${kind}' @${layout.position}`);
        }
    }
}

interface IInclusionState { root?: HTMLElement; }

export class InclusionFormatter extends Formatter<IInclusionState> {
    public createState() { return {}; }

    public begin(state: IInclusionState, layout: Layout) {
        const segment = layout.segment;
        if (!state.root) {
            state.root = document.createElement(Tag.span);
            state.root.contentEditable = "false";
            const slot = document.createElement(Tag.span);
            state.root.appendChild(slot);

            layout.doc.getComponent(segment as Marker).then((component: IComponent | ILegacyComponent) => {
                // TODO included for back compat - can remove once we migrate to 0.5
                if ("attach" in component) {
                    const legacyComponent = component as ILegacyComponent;
                    legacyComponent.attach(new ServicePlatform([["div", Promise.resolve(slot)]]));
                } else {
                    const renderable = (component as IComponent).query<IComponentRenderHTML>("IComponentRenderHTML");
                    if (renderable) {
                        renderable.render(slot);
                    }
                }
            });
        }

        const root = state.root;
        syncCss(root, getCss(segment), styles.inclusion);
        layout.pushNode(root);
    }

    public visit(state: IInclusionState, layout: Layout) {
        assert.strictEqual(getDocSegmentKind(layout.segment), DocSegmentKind.inclusion);
        layout.popFormat();
        return true;
    }

    public end(state: IInclusionState, layout: Layout) {
        layout.popNode();
    }
}

interface ITagsState extends IFormatterState { root?: HTMLElement; pTag: Tag; popCount: number; }
interface ITagsProps { tags?: Tag[]; }

class TagsFormatter extends Formatter<ITagsState> {
    public createState(): ITagsState { return { popCount: 0, pTag: undefined }; }

    public begin(state: ITagsState, layout: Layout) {
        const segment = layout.segment;
        const props: ITagsProps = (segment && segment.properties) || {};
        const tags = props.tags;

        state.root = this.pushTag(layout, tags[0], state.root) as HTMLElement;
        const root = state.root;
        syncCss(root, getCss(segment), undefined);

        for (let index = 1, existing: Element = root; index < tags.length; index++) {
            existing = existing && existing.firstElementChild;
            this.pushTag(layout, tags[index], existing);
        }

        state.popCount = tags.length;
        state.pTag = tags[tags.length - 1];
    }

    public visit(state: Readonly<ITagsState>, layout: Layout) {
        const segment = layout.segment;
        const kind = getDocSegmentKind(segment);

        switch (kind) {
            case DocSegmentKind.text: {
                layout.emitText();
                return true;
            }

            case DocSegmentKind.paragraph: {
                layout.popNode();
                const previous = layout.cursor.previous;
                const next = previous && previous.nextSibling as Node | Element;

                const pg = (next && "tagName" in next && next.tagName === state.pTag)
                    ? next
                    : document.createElement(state.pTag);

                syncCss(pg as HTMLElement, getCss(segment), undefined);
                layout.pushNode(pg);
                return true;
            }

            case DocSegmentKind.inclusion: {
                layout.pushFormat(inclusionFormatter);
                return false;
            }

            case DocSegmentKind.endTags: {
                layout.emitNode(document.createElement(Tag.br));
                layout.popFormat();
                return true;
            }

            default:
                debug("%s@%d: Unhanded DocSegmentKind '%s'.", this, layout.position, kind);
                layout.popFormat();
                return false;
        }
    }

    public end(state: Readonly<ITagsState>, layout: Layout) {
        for (let i = state.popCount; i > 0; i--) {
            layout.popNode();
        }
    }
}

interface IParagraphState extends IFormatterState { root?: HTMLElement; }

class ParagraphFormatter extends Formatter<IParagraphState> {
    constructor(private readonly defaultTag: Tag) { super (); }

    public createState(): IParagraphState { return { }; }

    public begin(state: IParagraphState, layout: Layout) {
        const segment = layout.segment;
        // tslint:disable-next-line:strict-boolean-expressions
        const tag = (segment.properties && segment.properties.tag) || this.defaultTag;
        state.root = this.pushTag(layout, tag, state.root) as HTMLElement;
        syncCss(state.root, getCss(segment), undefined);
    }

    public visit(state: Readonly<IParagraphState>, layout: Layout) {
        const segment = layout.segment;
        const kind = getDocSegmentKind(segment);

        switch (kind) {
            case DocSegmentKind.text: {
                layout.pushFormat(textFormatter);
                return false;
            }

            case DocSegmentKind.paragraph: {
                layout.popFormat();
                layout.pushFormat(this);
                return true;
            }

            case DocSegmentKind.inclusion: {
                layout.pushFormat(inclusionFormatter);
                return false;
            }

            default:
                debug("%s@%d: Unhanded DocSegmentKind '%s'.", this, layout.position, kind);
                layout.popFormat();
                return false;
        }
    }

    public end(state: Readonly<IParagraphState>, layout: Layout) {
        if (!layout.cursor.previous) {
            layout.emitNode(document.createElement(Tag.br));
        }
        layout.popNode();
    }
}

interface ITextState extends IFormatterState { root?: HTMLElement; css?: ICssProps; }

class TextFormatter extends Formatter<ITextState> {
    public createState(): ITextState { return { }; }

    public begin(state: ITextState, layout: Layout) {
        state.root = this.pushTag(layout, Tag.span, state.root) as HTMLElement;
        state.css = getCss(layout.segment);
        syncCss(state.root, state.css, undefined);
    }

    public visit(state: Readonly<ITextState>, layout: Layout) {
        const segment = layout.segment;
        const kind = getDocSegmentKind(segment);

        switch (kind) {
            case DocSegmentKind.text: {
                if (!sameCss(segment, state.css)) {
                    layout.popFormat();
                    return false;
                }
                layout.emitText();
                return true;
        }

            default:
                debug("%s@%d: Unhanded DocSegmentKind '%s'.", this, layout.position, kind);
                layout.popFormat();
                return false;
        }
    }

    public end(state: Readonly<ITextState>, layout: Layout) {
        layout.popNode();
    }
}

const inclusionFormatter = new InclusionFormatter();
const paragraphFormatter = new ParagraphFormatter(Tag.p);
const tagsFormatter = new TagsFormatter();
const textFormatter = new TextFormatter();