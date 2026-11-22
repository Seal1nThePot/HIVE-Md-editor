import type { RefObject } from 'react';
import type { EditorView } from '@codemirror/view';
import { Transaction,type Text } from '@codemirror/state';
import { canApplyToDocument, headings, modeLabels, previewIntact, visibleCount, type Mode, type Proposal, type UndoEdit } from '../../shared/core';
import type { HistoryRecord } from '../history/historyTypes';
import type { planHistoryText } from '../history/historyText';
import type { DiskFile } from '../../shared/fileTypes';
import { headingKey, type WritingNode } from '../outline/writingNodes';
import type { Message } from './chatTypes';
type ProposalContext = {
    view: RefObject<EditorView | null>;
    disk: RefObject<DiskFile | null>;
    proposal: RefObject<Proposal | null>;
    undo: RefObject<UndoEdit[]>;
    writingOutline: {
        nodes: WritingNode[];
        save: (nodes: WritingNode[]) => Promise<unknown>;
    };
    add: (role: Message['role'], content: string) => void;
    setError: (message: string) => void;
    inform: (message: string) => void;
    redraw: () => void;
    setMode: (mode: Mode) => void;
    openChat: () => void;
    promptRef: RefObject<HTMLTextAreaElement | null>;
    onAccepted?: (proposal:Proposal, doc:Text)=>string;
    onReverted?: (historyId:string)=>void;
};

/** Reopen a journaled comparison at the restored range chosen by history's conflict planner. */
export function replayPolishProposal(record:HistoryRecord, plan:ReturnType<typeof planHistoryText> | null, reverse:boolean):Proposal|null {
    const {file, changes:{polish, text}} = record;
    if (!reverse || record.actor !== 'ai' || !file || !polish || text?.length !== 1 || plan?.changes.length !== 1)
        return null;
    const [patch] = text, [{from, insert}] = plan.changes;
    if (insert !== patch.before) return null;
    return {
        ...polish,
        historyId:record.id,
        placement:'comparison', mode:'edit', file, from, to:from + patch.before.length,
        original:patch.before, text:patch.after, count:visibleCount(patch.after), stale:false,
    };
}

export function createProposalActions({ view, disk, proposal, undo, writingOutline, add, setError, inform, redraw, setMode, openChat, promptRef,onAccepted,onReverted }: ProposalContext) {
    function editCandidate(text:string) {
        const a = proposal.current;
        if (a?.placement !== 'comparison' || text === a.text) return;
        proposal.current = { ...a, text, count: visibleCount(text) };
        redraw();
    }
    function editRefinementNote(refinementNote:string) {
        const a = proposal.current;
        if (a?.placement !== 'comparison' || refinementNote === a.refinementNote) return;
        proposal.current = { ...a, refinementNote };
        redraw();
    }
    function accept() {
        const a = proposal.current, v = view.current;
        if (!a || !v || !disk.current)
            return;
        if(v.state.readOnly){setError('当前正文只读，请切换到可编辑的显示模式。');return;}
        if (!previewIntact(a, v.state.doc, disk.current.path)) {
            proposal.current = { ...a, stale: true };
            setError("这段文字已经被手改或位置变了，请先核对再决定保留还是撤掉。");
            redraw();
            return;
        }
        const comparison = a.placement === 'comparison';
        if (comparison && a.text === a.original) return;
        proposal.current = null;
        if (comparison) {
            v.dispatch({
                changes: { from: a.from, to: a.to, insert: a.text },
                selection: { anchor: a.from },
                userEvent: 'input.ai.accept',
                annotations: Transaction.addToHistory.of(false),
            });
        }
        const accepted = comparison ? { ...a, to: a.from + a.text.length } : a;
        undo.current.push({
            from: accepted.from,
            to: accepted.to,
            original: a.text,
            before: a.original,
            stale: false,
            file: a.file,
            historyId: onAccepted?.(accepted,v.state.doc),
            ...(comparison ? { comparison:a } : {}),
        });
        if (a.mode === "outline" && a.creatingHeading && a.writingNodeId) {
            const nodes = writingOutline.nodes;
            const node = nodes.find((node) => node.id === a.writingNodeId);
            const currentHeadings = headings(v.state);
            const added = node
                ? currentHeadings.find((heading) => heading.from >= a.from &&
                    heading.from < a.from + a.text.length && heading.title === a.node)
                : undefined;
            if (node && added)
                void writingOutline.save(nodes.map((value) => value.id === node.id
                    ? { ...value, targetHeading: headingKey(currentHeadings, added) }
                    : value)).catch(() => { });
        }
        add("system", `已保留「${a.node}」的${modeLabels[a.mode]}：${a.text.trim()}。`);
        inform("已保留这段建议。");
        redraw();
    }
    function reject(adjust = false) {
        const a = proposal.current, v = view.current;
        if (!a)
            return;
        if(a.placement==='comparison'){
            proposal.current=null;
            inform('已取消润色预览。');
            redraw();
            return;
        }
        if(v?.state.readOnly){setError('当前正文只读，请切换到可编辑的显示模式。');return;}
        proposal.current = null;
        const removable = !!v && !!disk.current && previewIntact(a, v.state.doc, disk.current.path);
        if (removable)
            v!.dispatch({
                changes: { from: a.from, to: a.to, insert: a.original },
                selection: { anchor: a.from },
                userEvent: "input.ai.reject",
                annotations: Transaction.addToHistory.of(false),
            });
        add("system", removable
            ? `已${adjust ? "退回调整" : "撤掉"}「${a.node}」的${modeLabels[a.mode]}，正文回到原来的内容。`
            : `「${a.node}」那段预览已经被手改，没有再动它，请自行核对那段文字。`);
        if (adjust) {
            setMode(a.mode);
            openChat();
            promptRef.current?.focus();
        }
        redraw();
    }
    function undoAI() {
        const a = undo.current.at(-1), v = view.current;
        if (!a || !v || !disk.current)
            return;
        if(v.state.readOnly){setError('当前正文只读，请切换到可编辑的显示模式。');return;}
        if (proposal.current) {
            setError('请先处理当前建议，再撤回已采纳的修改。');
            return;
        }
        if (!canApplyToDocument(a, v.state.doc, disk.current.path)) {
            setError("这处 AI 修改之后又被手改，已阻止自动撤回。请手动核对该位置。");
            return;
        }
        undo.current.pop();
        v.dispatch({
            changes: { from: a.from, to: a.to, insert: a.before },
            userEvent: "input.ai.undo",
            annotations: Transaction.addToHistory.of(false),
        });
        if(a.comparison)proposal.current={...a.comparison,from:a.from,to:a.from+a.before.length,stale:false,historyId:a.historyId,refinementNote:undefined};
        if(a.historyId)onReverted?.(a.historyId);
        add("system", "用户撤回了最近一次 AI 修改，范围外的手写内容保留。请以后续最新正文为准。");
        inform("已撤回最近一次 AI 修改。");
        redraw();
    }
    return { accept, reject, undoAI, editCandidate, editRefinementNote };
}
