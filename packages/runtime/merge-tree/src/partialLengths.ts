/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
// tslint:disable: no-suspicious-comment
import { Property } from "./base";
import { RedBlackTree } from "./collections";
import {
    CollaborationWindow,
    compareNumbers,
    IMergeBlock,
    internedSpaces,
    IRemovalInfo,
    ISegment,
    MergeTree,
    UnassignedSequenceNumber,
} from "./mergeTree";

interface IOverlapClient {
    clientId: number;
    seglen: number;
}

/**
 * Returns the partial length whose sequence number is
 * the greatest sequence number within a that is
 * less than or equal to key.
 * @param a - array of partial segment lengths
 * @param key - sequence number
 */
function latestLEQ(a: PartialSequenceLength[], key: number) {
    let best = -1;
    let lo = 0;
    let hi = a.length - 1;
    while (lo <= hi) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (a[mid].seq <= key) {
            if ((best < 0) || (a[best].seq < a[mid].seq)) {
                best = mid;
            }
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// tslint:disable-next-line: interface-name
export interface PartialSequenceLength {
    seq: number;
    len: number;
    seglen: number;
    clientId?: number;
    overlapRemoveClients?: RedBlackTree<number, IOverlapClient>;
}

/**
 * Keep track of partial sums of segment lengths for all sequence numbers
 * in the current collaboration window (if any).  Only used during active
 * collaboration.
 */
export class PartialSequenceLengths {
    public static options = {
        zamboni: true,
    };

    public static fromLeaves(mergeTree: MergeTree, branchId: number, combinedPartialLengths: PartialSequenceLengths,
                             block: IMergeBlock, collabWindow: CollaborationWindow) {
        combinedPartialLengths.minLength = 0;
        combinedPartialLengths.segmentCount = block.childCount;

        function seqLTE(seq: number, minSeq: number) {
            return (seq !== UnassignedSequenceNumber) && (seq <= minSeq);
        }

        for (let i = 0; i < block.childCount; i++) {
            const child = block.children[i];
            if (child.isLeaf()) {
                // leaf segment
                const segment =  child as ISegment;
                const segBranchId = mergeTree.getBranchId(segment.clientId);
// tslint:disable-next-line: max-line-length
                // console.log(`seg br ${segBranchId} cli ${glc(mergeTree, segment.clientId)} me ${glc(mergeTree, mergeTree.collabWindow.clientId)}`);
                if (segBranchId <= branchId) {
                    if (seqLTE(segment.seq, collabWindow.minSeq)) {
                        combinedPartialLengths.minLength += segment.cachedLength;
                    } else {
                        if (segment.seq !== UnassignedSequenceNumber) {
                            PartialSequenceLengths.insertSegment(combinedPartialLengths, segment);
                        }
                    }
                    const removalInfo = mergeTree.getRemovalInfo(branchId, segBranchId, segment);
                    if (seqLTE(removalInfo.removedSeq, collabWindow.minSeq)) {
                        combinedPartialLengths.minLength -= segment.cachedLength;
                    } else {
                        if ((removalInfo.removedSeq !== undefined) &&
                            (removalInfo.removedSeq !== UnassignedSequenceNumber)) {
                            PartialSequenceLengths.insertSegment(
                                combinedPartialLengths,
                                segment,
                                true,
                                removalInfo);
                        }
                    }
                }
            }
        }
        // post-process correctly-ordered partials computing sums and creating
        // lists for each present client id
        const seqPartials = combinedPartialLengths.partialLengths;
        const seqPartialsLen = seqPartials.length;

        let prevLen = 0;
        for (let i = 0; i < seqPartialsLen; i++) {
            seqPartials[i].len = prevLen + seqPartials[i].seglen;
            prevLen = seqPartials[i].len;
            combinedPartialLengths.addClientSeqNumberFromPartial(seqPartials[i]);
        }
    }

    public static combine(mergeTree: MergeTree, block: IMergeBlock, collabWindow: CollaborationWindow, recur = false) {
        const partialLengthsTopBranch = PartialSequenceLengths.combineBranch(mergeTree, block, collabWindow, 0, recur);
        if (mergeTree.localBranchId > 0) {
            partialLengthsTopBranch.downstreamPartialLengths =  [] as PartialSequenceLengths[];
            for (let i = 0; i < mergeTree.localBranchId; i++) {
                partialLengthsTopBranch.downstreamPartialLengths[i] =
                    PartialSequenceLengths.combineBranch(mergeTree, block, collabWindow, i + 1, recur);
            }
        }
        return partialLengthsTopBranch;
    }
    /**
     * Combine the partial lengths of block's children
     * @param block - an interior node; it is assumed that each interior node child of this block
     * has its partials up to date
     * @param collabWindow - segment window of the segment tree containing textSegmentBlock
     */
// tslint:disable-next-line: max-func-body-length
    public static combineBranch(
        mergeTree: MergeTree,
        block: IMergeBlock,
        collabWindow: CollaborationWindow,
        branchId: number,
        recur = false) {
        let combinedPartialLengths = new PartialSequenceLengths(collabWindow.minSeq);
        PartialSequenceLengths.fromLeaves(mergeTree, branchId, combinedPartialLengths, block, collabWindow);
        let prevPartial: PartialSequenceLength;

        function combineOverlapClients(a: PartialSequenceLength, b: PartialSequenceLength) {
            if (a.overlapRemoveClients) {
                if (b.overlapRemoveClients) {
                    b.overlapRemoveClients.map((bProp: Property<number, IOverlapClient>) => {
                        const aProp = a.overlapRemoveClients.get(bProp.key);
                        if (aProp) {
                            aProp.data.seglen += bProp.data.seglen;
                        } else {
                            a.overlapRemoveClients.put(bProp.data.clientId, bProp.data);
                        }
                        return true;
                    });
                }
            } else {
                a.overlapRemoveClients = b.overlapRemoveClients;
            }
        }

        function addNext(partialLength: PartialSequenceLength) {
            const seq = partialLength.seq;
            let pLen = 0;

            if (prevPartial) {
                if (prevPartial.seq === partialLength.seq) {
                    prevPartial.seglen += partialLength.seglen;
                    prevPartial.len += partialLength.seglen;
                    combineOverlapClients(prevPartial, partialLength);
                    return;
                } else {
                    pLen = prevPartial.len;
                    // previous sequence number is finished
                    combinedPartialLengths.addClientSeqNumberFromPartial(prevPartial);
                }
            }
            prevPartial = {
                clientId: partialLength.clientId,
                len: pLen + partialLength.seglen,
                overlapRemoveClients: partialLength.overlapRemoveClients,
                seglen: partialLength.seglen,
                seq,
            };
            combinedPartialLengths.partialLengths.push(prevPartial);
        }

        const childPartials: PartialSequenceLengths[] = [];
        for (let i = 0; i < block.childCount; i++) {
            const child = block.children[i];
            if (!child.isLeaf()) {
                const childBlock =  child as IMergeBlock;
                if (recur) {
                    childBlock.partialLengths =
                        PartialSequenceLengths.combine(mergeTree, childBlock, collabWindow, true);
                }
                childPartials.push(childBlock.partialLengths.partialLengthsForBranch(branchId));
            }
        }
        let childPartialsLen = childPartials.length;
        if (childPartialsLen !== 0) {
            // some children are interior nodes
            if (combinedPartialLengths.partialLengths.length > 0) {
                // some children were leaves; add combined partials from these segments
                childPartials.push(combinedPartialLengths);
                childPartialsLen++;
                combinedPartialLengths = new PartialSequenceLengths(collabWindow.minSeq);
            }
            const indices = new Array<number>(childPartialsLen);
            const childPartialsCounts = new Array<number>(childPartialsLen);
            for (let i = 0; i < childPartialsLen; i++) {
                indices[i] = 0;
                childPartialsCounts[i] = childPartials[i].partialLengths.length;
                combinedPartialLengths.minLength += childPartials[i].minLength;
                combinedPartialLengths.segmentCount += childPartials[i].segmentCount;
            }
            let outerIndexOfEarliest = 0;
            let earliestPartialLength: PartialSequenceLength;
            while (outerIndexOfEarliest >= 0) {
                outerIndexOfEarliest = -1;
                for (let k = 0; k < childPartialsLen; k++) {
                    // find next earliest sequence number
                    if (indices[k] < childPartialsCounts[k]) {
                        const cpLen = childPartials[k].partialLengths[indices[k]];
                        if ((outerIndexOfEarliest < 0) || (cpLen.seq < earliestPartialLength.seq)) {
                            outerIndexOfEarliest = k;
                            earliestPartialLength = cpLen;
                        }
                    }
                }
                if (outerIndexOfEarliest >= 0) {
                    addNext(earliestPartialLength);
                    indices[outerIndexOfEarliest]++;
                }
            }
            // add client entry for last partial, if any
            if (prevPartial) {
                combinedPartialLengths.addClientSeqNumberFromPartial(prevPartial);
            }
        }
        // TODO: incremental zamboni during build
        // console.log(combinedPartialLengths.toString());
        // console.log(`ZZZ...(min ${segmentWindow.minSeq})`);
        if (PartialSequenceLengths.options.zamboni) {
            combinedPartialLengths.zamboni(collabWindow);
        }
        // console.log(combinedPartialLengths.toString());
        return combinedPartialLengths;
    }

    private static getOverlapClients(overlapClientids: number[], seglen: number) {
        const bst = new RedBlackTree<number, IOverlapClient>(compareNumbers);
        for (const clientId of overlapClientids) {
            bst.put(clientId,  { clientId, seglen });
        }
        return bst;
    }

    private static accumulateRemoveClientOverlap(
        partialLength: PartialSequenceLength,
        overlapRemoveClientIds: number[],
        seglen: number) {
        if (partialLength.overlapRemoveClients) {
            for (const clientId of overlapRemoveClientIds) {
                const ovlapClientNode = partialLength.overlapRemoveClients.get(clientId);
                if (!ovlapClientNode) {
                    partialLength.overlapRemoveClients.put(clientId,  { clientId, seglen });
                } else {
                    ovlapClientNode.data.seglen += seglen;
                }
            }
        } else {
            partialLength.overlapRemoveClients =
                PartialSequenceLengths.getOverlapClients(overlapRemoveClientIds, seglen);
        }
    }

    private static insertSegment(
        combinedPartialLengths: PartialSequenceLengths,
        segment: ISegment,
        removedSeq = false,
        removalInfo?: IRemovalInfo) {
        let seq = segment.seq;
        let segmentLen = segment.cachedLength;
        let clientId = segment.clientId;
        let removeClientOverlap: number[];

        if (removedSeq) {
            seq = removalInfo.removedSeq;
            segmentLen = -segmentLen;
            clientId = removalInfo.removedClientId;
            if (removalInfo.removedClientOverlap) {
                removeClientOverlap = removalInfo.removedClientOverlap;
            }
        }

        const seqPartials = combinedPartialLengths.partialLengths;
        const seqPartialsLen = seqPartials.length;
        // find the first entry with sequence number greater or equal to seq
        let indexFirstGTE = 0;
        for (; indexFirstGTE < seqPartialsLen; indexFirstGTE++) {
            if (seqPartials[indexFirstGTE].seq >= seq) {
                break;
            }
        }
        if ((indexFirstGTE < seqPartialsLen) && (seqPartials[indexFirstGTE].seq === seq)) {
            seqPartials[indexFirstGTE].seglen += segmentLen;
            if (removeClientOverlap) {
                PartialSequenceLengths.accumulateRemoveClientOverlap(
                    seqPartials[indexFirstGTE],
                    removeClientOverlap,
                    segmentLen);
            }
        } else {
            let pLen: PartialSequenceLength;
            if (removeClientOverlap) {
                const overlapClients = PartialSequenceLengths.getOverlapClients(removeClientOverlap, segmentLen);
                pLen = { seq, clientId, len: 0, seglen: segmentLen, overlapRemoveClients: overlapClients };
            } else {
                pLen = { seq, clientId, len: 0, seglen: segmentLen };
            }

            if (indexFirstGTE < seqPartialsLen) {
                // shift entries with greater sequence numbers
                // TODO: investigate performance improvement using BST
                for (let k = seqPartialsLen; k > indexFirstGTE; k--) {
                    seqPartials[k] = seqPartials[k - 1];
                }
                seqPartials[indexFirstGTE] = pLen;
            } else {
                seqPartials.push(pLen);
            }
        }
    }

    private static addSeq(partialLengths: PartialSequenceLength[], seq: number, seqSeglen: number, clientId?: number) {
        let seqPartialLen: PartialSequenceLength;
        let penultPartialLen: PartialSequenceLength;
        let leqIndex = latestLEQ(partialLengths, seq);
        if (leqIndex >= 0) {
            const pLen = partialLengths[leqIndex];
            if (pLen.seq === seq) {
                seqPartialLen = pLen;
                leqIndex = latestLEQ(partialLengths, seq - 1);
                if (leqIndex >= 0) {
                    penultPartialLen = partialLengths[leqIndex];
                }
            } else {
                penultPartialLen = pLen;
            }
        }
        if (seqPartialLen === undefined) {
            // tslint:disable-next-line: no-object-literal-type-assertion
            seqPartialLen = {
                clientId,
                seglen: seqSeglen,
                seq,
            } as PartialSequenceLength;
            partialLengths.push(seqPartialLen);
        } else {
            seqPartialLen.seglen = seqSeglen;
            // assert client id matches
        }
        if (penultPartialLen !== undefined) {
            seqPartialLen.len = seqPartialLen.seglen + penultPartialLen.len;
        } else {
            seqPartialLen.len = seqPartialLen.seglen;
        }

    }
    public minLength = 0;
    public segmentCount = 0;
    public partialLengths: PartialSequenceLength[] = [];
    public clientSeqNumbers: PartialSequenceLength[][] = [];
    public downstreamPartialLengths: PartialSequenceLengths[];

    constructor(public minSeq: number) {
    }

    public cliLatestLEQ(clientId: number, refSeq: number) {
        const cliSeqs = this.clientSeqNumbers[clientId];
        if (cliSeqs) {
            return latestLEQ(cliSeqs, refSeq);
        } else {
            return -1;
        }
    }

    public cliLatest(clientId: number) {
        const cliSeqs = this.clientSeqNumbers[clientId];
        if (cliSeqs && (cliSeqs.length > 0)) {
            return cliSeqs.length - 1;
        } else {
            return -1;
        }
    }

    public compare(b: PartialSequenceLengths) {
        function comparePartialLengths(aList: PartialSequenceLength[], bList: PartialSequenceLength[]) {
            const aLen = aList.length;
            const bLen = bList.length;
            if (aLen !== bLen) {
                return false;
            }
            for (let i = 0; i < aLen; i++) {
                const aPartial = aList[i];
                const bPartial = bList[i];
                if ((aPartial.seq !== bPartial.seq) || (aPartial.clientId !== bPartial.clientId) ||
                    (aPartial.seglen !== bPartial.seglen) || (aPartial.len !== bPartial.len) ||
                    (aPartial.overlapRemoveClients && (!bPartial.overlapRemoveClients))) {
                    return false;
                }
            }
            return true;
        }
        if (!comparePartialLengths(this.partialLengths, b.partialLengths)) {
            return false;
        }
        // tslint:disable-next-line: no-for-in no-for-in-array forin
        for (const clientId in this.clientSeqNumbers) {
            if (!b.clientSeqNumbers[clientId]) {
                return false;
            } else if (!comparePartialLengths(this.clientSeqNumbers[clientId], b.clientSeqNumbers[clientId])) {
                return false;
            }
        }
        return true;
    }

    public branchToString(glc?: (id: number) => string, branchId = 0) {
        let buf = "";
        for (const partial of this.partialLengths) {
            buf += `(${partial.seq},${partial.len}) `;
        }
        // tslint:disable-next-line: no-for-in no-for-in-array forin
        for (const clientId in this.clientSeqNumbers) {
            if (this.clientSeqNumbers[clientId].length > 0) {
                buf += `Client `;
                if (glc) {
                    buf += `${glc(+clientId)}`;
                } else {
                    buf += `${clientId}`;
                }
                buf += "[";
                for (const partial of this.clientSeqNumbers[clientId]) {
                    buf += `(${partial.seq},${partial.len})`;
                }
                buf += "]";
            }
        }
        buf = `Br ${branchId}, min(seq ${this.minSeq}): ${this.minLength}; sc: ${this.segmentCount};${buf}`;
        return buf;
    }

    public toString(glc?: (id: number) => string, indentCount = 0) {
        let buf = this.branchToString(glc);
        if (this.downstreamPartialLengths) {
            for (let i = 0, len = this.downstreamPartialLengths.length; i < len; i++) {
                buf += "\n";
                buf += internedSpaces(indentCount);
                buf += this.downstreamPartialLengths[i].branchToString(glc, i + 1);
            }
        }
        return buf;
    }

    public getPartialLength(mergeTree: MergeTree, refSeq: number, clientId: number) {
        const branchId = mergeTree.getBranchId(clientId);
        if (MergeTree.traceTraversal) {
            console.log(`plen branch ${branchId}`);
        }
        if (branchId > 0) {
            return this.downstreamPartialLengths[branchId - 1].getBranchPartialLength(refSeq, clientId);
        } else {
            return this.getBranchPartialLength(refSeq, clientId);
        }
    }

    public getBranchPartialLength(refSeq: number, clientId: number) {
        let pLen = this.minLength;
        const seqIndex = latestLEQ(this.partialLengths, refSeq);
        const cliLatestindex = this.cliLatest(clientId);
        const cliSeq = this.clientSeqNumbers[clientId];
        if (seqIndex >= 0) {
            pLen += this.partialLengths[seqIndex].len;
            if (cliLatestindex >= 0) {
                const cliLatest = cliSeq[cliLatestindex];

                if (cliLatest.seq > refSeq) {
                    pLen += cliLatest.len;
                    const precedingCliIndex = this.cliLatestLEQ(clientId, refSeq);
                    if (precedingCliIndex >= 0) {
                        pLen -= cliSeq[precedingCliIndex].len;
                    }
                }
            }
        } else {
            if (cliLatestindex >= 0) {
                const cliLatest = cliSeq[cliLatestindex];
                pLen += cliLatest.len;
            }
        }
        return pLen;
    }

    // clear away partial sums for sequence numbers earlier than the current window
    public zamboni(segmentWindow: CollaborationWindow) {
        function copyDown(partialLengths: PartialSequenceLength[]) {
            const mindex = latestLEQ(partialLengths, segmentWindow.minSeq);
            let minLength = 0;
            // console.log(`mindex ${mindex}`);
            if (mindex >= 0) {
                minLength = partialLengths[mindex].len;
                const seqCount = partialLengths.length;
                if (mindex <= (seqCount - 1)) {
                    // still some entries remaining
                    const remainingCount = (seqCount - mindex) - 1;
                    // copy down
                    for (let i = 0; i < remainingCount; i++) {
                        partialLengths[i] = partialLengths[i + mindex + 1];
                        partialLengths[i].len -= minLength;
                    }
                    partialLengths.length = remainingCount;
                }
            }
            return minLength;
        }
        this.minLength += copyDown(this.partialLengths);
        // tslint:disable-next-line: no-for-in no-for-in-array forin
        for (const clientId in this.clientSeqNumbers) {
            const cliPartials = this.clientSeqNumbers[clientId];
            if (cliPartials) {
                copyDown(cliPartials);
            }
        }
    }

    public addClientSeqNumber(clientId: number, seq: number, seglen: number) {
        if (this.clientSeqNumbers[clientId] === undefined) {
            this.clientSeqNumbers[clientId] = [];
        }
        const cli = this.clientSeqNumbers[clientId];
        let pLen = seglen;
        if (cli.length > 0) {
            pLen += cli[cli.length - 1].len;
        }
        cli.push({ seq, len: pLen, seglen });

    }
    // assumes sequence number already coalesced
    public addClientSeqNumberFromPartial(partialLength: PartialSequenceLength) {
        this.addClientSeqNumber(partialLength.clientId, partialLength.seq, partialLength.seglen);
        if (partialLength.overlapRemoveClients) {
            partialLength.overlapRemoveClients.map((oc: Property<number, IOverlapClient>) => {
                this.addClientSeqNumber(oc.data.clientId, partialLength.seq, oc.data.seglen);
                return true;
            });
        }
    }

    public update(
        mergeTree: MergeTree,
        block: IMergeBlock,
        seq: number,
        clientId: number,
        collabWindow: CollaborationWindow) {
        const segBranchId = mergeTree.getBranchId(clientId);
        // tslint:disable-next-line: max-line-length
        // console.log(`seg br ${segBranchId} cli ${glc(mergeTree, segment.clientId)} me ${glc(mergeTree, mergeTree.collabWindow.clientId)}`);
        if (segBranchId === 0) {
            this.updateBranch(mergeTree, 0, block, seq, clientId, collabWindow);
        }
        if (mergeTree.localBranchId > 0) {
            for (let i = 0; i < mergeTree.localBranchId; i++) {
                const branchId = i + 1;
                if (segBranchId <= branchId) {
                    this.downstreamPartialLengths[i].updateBranch(
                        mergeTree,
                        branchId,
                        block,
                        seq,
                        clientId,
                        collabWindow);
                }
            }
        }

    }

    // assume: seq is latest sequence number; no structural change to sub-tree, but a segment
    // with sequence number seq has been added within the sub-tree
    // TODO: assert client id matches
    public updateBranch(
        mergeTree: MergeTree,
        branchId: number,
        node: IMergeBlock,
        seq: number,
        clientId: number,
        collabWindow: CollaborationWindow) {
        let seqSeglen = 0;
        let segCount = 0;
        // compute length for seq across children
        for (let i = 0; i < node.childCount; i++) {
            const child = node.children[i];
            if (!child.isLeaf()) {
                const childBlock =  child as IMergeBlock;
                const branchPartialLengths = childBlock.partialLengths.partialLengthsForBranch(branchId);
                const partialLengths = branchPartialLengths.partialLengths;
                const seqIndex = latestLEQ(partialLengths, seq);
                if (seqIndex >= 0) {
                    const leqPartial = partialLengths[seqIndex];
                    if (leqPartial.seq === seq) {
                        seqSeglen += leqPartial.seglen;
                    }
                }
                segCount += branchPartialLengths.segmentCount;
            } else {
                const segment =  child as ISegment;

                const segBranchId = mergeTree.getBranchId(segment.clientId);
                const removalInfo = mergeTree.getRemovalInfo(branchId, segBranchId, segment);

                if (segment.seq === seq) {
                    if (removalInfo.removedSeq !== seq) {
                        seqSeglen += segment.cachedLength;
                    }
                } else {
                    if (removalInfo.removedSeq === seq) {
                        seqSeglen -= segment.cachedLength;
                    }
                }
                segCount++;
            }
        }
        this.segmentCount = segCount;

        PartialSequenceLengths.addSeq(this.partialLengths, seq, seqSeglen, clientId);
        if (this.clientSeqNumbers[clientId] === undefined) {
            this.clientSeqNumbers[clientId] = [];
        }
        PartialSequenceLengths.addSeq(this.clientSeqNumbers[clientId], seq, seqSeglen);
        //    console.log(this.toString());
        if (PartialSequenceLengths.options.zamboni) {
            this.zamboni(collabWindow);
        }
        //   console.log('ZZZ');
        //   console.log(this.toString());
    }

    public partialLengthsForBranch(branchId: number) {
        if (branchId > 0) {
            return this.downstreamPartialLengths[branchId - 1];
        } else {
            return this;
        }
    }
}