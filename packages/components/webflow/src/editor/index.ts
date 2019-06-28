/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

export { Editor, IEditorProps } from "./layout/editor";
export { PagePosition } from "./pagination";

import { Component } from "@prague/app-component";
import { randomId, Scheduler } from "@prague/flow-util";
import { MapExtension } from "@prague/map";
import { FlowDocument } from "../document";
import { Editor } from "./layout/editor";

export class FlowEditor extends Component {
    // tslint:disable-next-line:no-require-imports
    public static readonly type = "@chaincode/flow-editor";

    constructor() {
        super([[MapExtension.Type, new MapExtension()]]);
    }

    public async opened() {
        const maybeDiv = await this.platform.queryInterface<HTMLElement>("div");
        if (maybeDiv) {
            const doc = await this.runtime.openComponent<FlowDocument>(await this.root.wait("docId"), true);
            const editor = new Editor();
            const root = editor.mount({ doc, scheduler: new Scheduler(), trackedPositions: [] });
            maybeDiv.appendChild(root);
        }
    }

    protected async create() {
        // tslint:disable-next-line:insecure-random
        const docId = randomId();
        this.runtime.createAndAttachComponent(docId, FlowDocument.type);
        this.root.set("docId", docId);
    }
}