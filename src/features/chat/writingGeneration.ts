import type { Dispatch, RefObject, SetStateAction } from 'react';
import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { canApply, makePrompt, previewIntact, readAnswer, streamPreview, visibleCount, type Anchor, type Heading, type Mode, type Proposal } from '../../shared/core';
import type { DiskFile } from '../../shared/fileTypes';
import type { EditorSession } from '../editor/editorSessionTypes';
import { annotationMessages, annotationSummary, type SubmittedAnnotation } from '../annotations/annotations';
import { targetForNode, type WritingNode } from '../outline/writingNodes';
import { activeModelLabel, type Config } from '../settings/modelConfig';
import { referenceOverrides, fitReferenceMessages, type ReferenceSource, type ResolvedReferences } from './referenceSources';
import type { ChatMessageDetails, Message } from './chatTypes';
import type { InputBasisRequest } from './InputBasisPanel';
import type { ReasoningEffort } from './modelReasoning';
import { generateDemoText, streamModelText } from './generationTransport';
export type GenerationOptions = {
    annotations?: SubmittedAnnotation[];
    instruction?: string;
    /** 快捷栏一步执行：本轮直接按指定模式生成，不再依赖面板里预先选好的模式。 */
    mode?: Mode;
    /** 配合上一条：输入框为空也允许发送，用该模式的默认要求。 */
    allowEmptyPrompt?: boolean;
    revision?: { proposalId:string; instruction:string };
    sourceAnnotationIds?: readonly string[];
};
export type WritingRequestOrigin = { annotationIds:readonly string[]; proposalId?:string };
export type GenerationContext = {
    document: {
        view: RefObject<EditorView | null>;
        disk: RefObject<DiskFile | null>;
        sessions: RefObject<Map<string, EditorSession>>;
        activeSession: RefObject<string>;
        file: string;
        outline: Heading[];
        currentHeading?: Heading;
        currentWritingNode?: WritingNode;
    };
    model: {
        config: Config;
        reasoningEffort: ReasoningEffort;
    };
    conversation: {
        mode: Mode;
        prompt: string;
        messages: Message[];
        setPrompt: Dispatch<SetStateAction<string>>;
        setLastRequest: (request: InputBasisRequest) => void;
        add: (role: Message['role'], content: string, details?: ChatMessageDetails) => void;
    };
    lifecycle: {
        running: RefObject<boolean>;
        generation: RefObject<number>;
        controller: RefObject<AbortController | null>;
        requestAnchor: RefObject<Anchor | null>;
        proposal: RefObject<Proposal | null>;
        origin?: RefObject<WritingRequestOrigin | null>;
    };
    references: {
        sources: ReferenceSource[];
    };
    writingOutline: {
        ready: boolean;
        busy: boolean;
        nodes: WritingNode[];
    };
    request: typeof fetch;
    annotationResponded: (submitted: SubmittedAnnotation[]) => void;
    ui: {
        setError: (message: string) => void;
        setBusy: (busy: boolean) => void;
        setStream: (text: string, documentFile?: string) => void;
        openPanel: (id: string) => void;
        inform: (message: string) => void;
        redraw: () => void;
    };
};
export function stopWritingGeneration(
    { generation, controller, requestAnchor, running, origin }: GenerationContext['lifecycle'],
    { setBusy, setStream }: Pick<GenerationContext['ui'], 'setBusy' | 'setStream'>,
) {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    requestAnchor.current = null;
    if (origin) origin.current = null;
    running.current = false;
    setBusy(false);
    setStream('');
}
// Receives the existing live references; it does not create a second document/session store.
export async function generateWriting(context: GenerationContext, options?: GenerationOptions) {
    const { document: { view, disk, sessions, activeSession, file, outline, currentHeading, currentWritingNode }, model: { config, reasoningEffort }, conversation: { mode, prompt, messages, setPrompt, setLastRequest, add }, lifecycle: { running, generation, controller, requestAnchor, proposal, origin }, references, writingOutline, request, annotationResponded, ui: { setError, setBusy, setStream, openPanel, inform, redraw } } = context;
    const uid = () => crypto.randomUUID();
    const submitted = options?.annotations;
    const revision = options?.revision;
    const usesPrompt = !submitted && !revision;
    const requestMode = submitted ? "discuss" : revision ? 'edit' : (options?.mode ?? mode);
    const v = view.current, requestDisk = disk.current;
    if (running.current ||
        (requestMode !== 'discuss' && (!v || !requestDisk)) ||
        (usesPrompt && !prompt.trim() && !options?.allowEmptyPrompt))
        return;
    if(requestMode!=='discuss'&&v?.state.readOnly){
        setError('当前正文只读，请切换到可编辑的显示模式。');
        return;
    }
    const prior = revision ? proposal.current : null;
    if (revision && (!revision.instruction.trim() || !prior || prior.id !== revision.proposalId || prior.placement !== 'comparison' || !previewIntact(prior, v?.state.doc, requestDisk?.path || ''))) {
        setError('润色预览或原文已变化，请重新核对并填写批注要求。');
        return;
    }
    if (proposal.current && !prior && requestMode !== "discuss") {
        setError("请先处理当前建议，或在建议框内继续调整。");
        return;
    }
    setError("");
    // 输入框留空时，用模式自己的默认要求，保证"点一下就能跑"。
    const defaultPrompt = requestMode === "edit"
        ? "请修改选中的内容。"
        : requestMode === "outline"
            ? "请按大纲写这一节。"
            : requestMode === "discuss"
                ? "请读一下正文，说说你的想法。"
                : "接着往下写。";
    const document = v?.state.doc.toString() ?? "", userPrompt = submitted
        ? (options?.instruction?.trim() || "请逐条回应这些文本标注。")
        : (revision?.instruction.trim() || prompt.trim() || defaultPrompt);
    if (!submitted && document.length > 80000) {
        setError("原型本轮最多发送 8 万字符的文档，请先缩小文档。");
        return;
    }
    const s = v?.state.selection.main;
    let from = s?.head ?? 0, to = from, target = "", node = "当前光标位置";
    let newNodeHeading = "", headingLine = "";
    if (prior) {
        ({from, to, node} = prior);
        target = prior.text;
    }
    else if (!submitted && requestMode === "edit") {
        if (!s || s.empty) {
            setError("请先在正文中选中一个词、一句话或一小段，再提出修改要求。");
            return;
        }
        from = s.from;
        to = s.to;
        target = document.slice(from, to);
        node = currentHeading?.title || "当前选区";
    }
    else if (!submitted && requestMode === "outline") {
        if (!writingOutline.ready || writingOutline.busy) {
            setError("写作大纲正在载入，请稍后再试。");
            return;
        }
        if (!currentWritingNode) {
            setError("请先在大纲中选择这一轮要完成的写作节点。");
            return;
        }
        const heading = targetForNode(currentWritingNode, outline);
        const next = heading
            ? outline.find((h) => h.from > heading.from && h.level <= heading.level)
            : undefined;
        from = to = next?.from ?? document.length;
        node = currentWritingNode.title;
        target = heading
            ? document.slice(heading.from, from)
            : document.slice(Math.max(0, document.length - 2500));
        if (!heading)
            newNodeHeading =
                "#".repeat(currentWritingNode.level) + " " + currentWritingNode.title;
        headingLine = heading ? document.slice(heading.from, heading.to) : newNodeHeading;
    }
    else {
        // 「往下续写」按字面意思落在文末：光标没进过正文（停在 0）时不把新段插到文首。
        const head = requestMode === "continue" && from === 0 ? document.length : from;
        from = to = head;
        target = document.slice(Math.max(0, head - 2500), head);
        node = currentHeading?.title || "当前光标位置";
    }
    const requestLimit = config.continuationLimit;
    const anchor: Anchor = {
        from,
        to,
        original: document.slice(from, to),
        stale: false,
        file: requestDisk?.path || "自由草稿",
    };
    const history = messages
        .filter((m) => m.id !== "welcome")
        .map((m) => ({
        role: m.role === "system" ? "user" : m.role,
        content: m.content,
    }));
    let requestMessages: {
        role: string;
        content: string;
    }[];
    try {
        requestMessages = submitted
            ? annotationMessages(submitted, userPrompt, history)
            : makePrompt(requestMode, document, target, node, userPrompt, history, {
                continuationLimit: requestLimit,
                nodeDescription: currentWritingNode?.description || "",
                writingOutline: writingOutline.nodes
                    .map((node) => "#".repeat(node.level) + " " + node.title)
                    .join("\n"),
                heading: headingLine || undefined,
                modelLabel: activeModelLabel(config),
            });
    }
    catch (error) {
        setError((error as Error).message);
        return;
    }
    const id = ++generation.current, abort = new AbortController(), requestSessionId = activeSession.current;
    const annotationIds = submitted?.map(item=>item.id) ?? (prior?.annotationIds ?? (requestMode === 'edit' ? options?.sourceAnnotationIds : undefined)) ?? [];
    if (origin) origin.current = { annotationIds, proposalId:prior?.id };
    requestAnchor.current = requestMode === 'discuss' ? null : anchor;
    controller.current = abort;
    running.current = true;
    setBusy(true);
    setStream("");
    let resolvedReferences: ResolvedReferences = { sources: [], files: [], warnings: [] };
    try {
        if (references.sources.length) {
            const selected = references.sources.map(source => ({ ...source })), buffers = [...sessions.current.values()].flatMap(session => { const state = session.view?.state || session.state; return session.disk && session.dirty && state ? [{ path: session.disk.path, text: state.doc.toString() }] : []; });
            const overrides = referenceOverrides(selected, buffers, file);
            const budget = Math.max(0, Math.min(60000, Math.floor(120000 - JSON.stringify(requestMessages).length - 6000)));
            const response = await request('/api/references/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: selected, currentFile: file, budget, overrides }), signal: abort.signal });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || '参考资料读取失败。');
            if (abort.signal.aborted || generation.current !== id)
                throw new DOMException('已停止', 'AbortError');
            const fitted = fitReferenceMessages(requestMessages, data);
            requestMessages = fitted.messages;
            resolvedReferences = fitted.references;
        }
    }
    catch (error) {
        if (generation.current === id) {
            running.current = false;
            setBusy(false);
            controller.current = null;
            requestAnchor.current = null;
            if (origin) origin.current = null;
            if (usesPrompt)
                setPrompt(old => old || userPrompt);
            if ((error as Error).name !== 'AbortError')
                setError((error as Error).message);
        }
        return;
    }
    const requestInfo = {
        messages: requestMessages,
        model: activeModelLabel(config), reasoningEffort: reasoningEffort, referenceDetails: { sources: resolvedReferences.sources, files: resolvedReferences.files.map(value => ({ path: value.path, source: value.source, characters: value.text.length, truncated: value.truncated })), warnings: resolvedReferences.warnings },
        demo: config.demo,
        mode: requestMode,
        node,
        scope: submitted
            ? `所选标注原文与备注＋当前会话 · ${submitted.length} 处`
            : requestMode === "edit"
                ? `${prior ? '当前润色结果' : '选区'} ${visibleCount(target)} 字`
                : requestMode === "discuss"
                    ? "仅讨论，不改正文"
                    : requestMode === "outline"
                        ? newNodeHeading
                            ? "文末创建大纲节点并插入正文"
                            : "指定章节末尾插入"
                        : "当前光标处插入",
        file: requestDisk?.path || (v ? "自由草稿" : "未打开文档"),
    };
    setLastRequest(requestInfo);
    const documentFile = requestDisk?.path;
    add("user", submitted ? annotationSummary(submitted, userPrompt) : userPrompt, {
        documentFile,
        ...(submitted ? { annotationBatch: { instruction: userPrompt, items: submitted } } : {}),
    });
    if (usesPrompt)
        setPrompt(old => old === userPrompt ? "" : old);
    if (resolvedReferences.warnings.length) {
        openPanel('basis');
        inform('部分参考资料有提示，可在依据的请求快照中查看。');
    }
    try {
        const raw = config.demo
            ? await generateDemoText({ requestMode, requestLimit, node, target, userPrompt, submitted, signal: abort.signal })
            : await streamModelText(request, { messages: requestMessages, selection: config.selection, reasoningEffort, signal: abort.signal }, text => { if (generation.current === id)
                setStream(requestMode === "discuss" ? text : streamPreview(text), documentFile); });
        if (generation.current !== id || abort.signal.aborted)
            return;
        if (requestMode === "discuss") {
            add("assistant", raw, { documentFile });
            if (submitted)
                annotationResponded(submitted);
            return;
        }
        const result = readAnswer(raw, requestMode, requestLimit);
        const latest = requestAnchor.current;
        if (!latest || !v || v!==view.current || requestSessionId!==activeSession.current || latest.file !== disk.current?.path)
            return;
        if(v.state.readOnly)
            throw new Error('当前正文只读，请切换到可编辑的显示模式后重新生成。');
        const now = v.state.doc.toString();
        let text = result.text;
        if (requestMode !== "edit") {
            const prefix = now.slice(0, latest.from), suffix = now.slice(latest.to);
            text =
                (prefix.endsWith("\n\n") || !prefix
                    ? ""
                    : prefix.endsWith("\n")
                        ? "\n"
                        : "\n\n") +
                    (newNodeHeading ? newNodeHeading + "\n\n" : "") +
                    text.trim() +
                    (suffix ? "\n\n" : "\n");
        }
        if (requestMode === "edit" && (!text.trim() || text.trim() === target.trim()))
            throw new Error("模型没有提出实际文字变化。请补充更具体的修改要求后重试。");
        const defaultReason =
            requestMode === "edit"
                ? "只改所选内容，其余保持不变。"
                : requestMode === "outline"
                    ? `按「${node}」的写作描述生成。`
                    : "承接上文继续往下写。";
        // 目标位置在生成过程中被手改过，就不再往正文里塞预览，避免把建议盖到别人的字上。
        if (!canApply(latest, now, disk.current?.path || "自由草稿"))
            throw new Error("目标位置在生成过程中被改动，本轮建议已作废，请重新生成。");
        if (requestMode === 'edit') {
            if (prior) {
                const current = proposal.current;
                if (current?.id !== prior.id) return;
                if (current.text !== prior.text)
                    throw new Error('等待期间润色结果已被手改，已保留你的修改。');
            }
            proposal.current = {
                ...latest, text, placement:'comparison', annotationIds,
                id:prior?.id ?? uid(), reason:result.reason || defaultReason, mode:requestMode,
                count:visibleCount(text), node,
            };
            if (!prior) {
                v.dispatch({ effects:EditorView.scrollIntoView(latest.from,{y:'center'}) });
                openPanel(activeSession.current);
            }
            add('assistant', `${config.demo ? '【交互演示】' : ''}已在原文下方${prior ? '更新' : '显示'}润色预览，共 ${visibleCount(text)} 字。`, { documentFile });
            redraw();
            return;
        }
        // Outline and continuation keep their existing inline preview workflow.
        const previewFrom = latest.from, previewText = text;
        const caret = previewFrom + (previewText.length - previewText.trimStart().length);
        v.dispatch({
            changes: { from: previewFrom, to: latest.to, insert: previewText },
            // 光标停在这段建议的开头：视口会滚到框顶（那里正好是操作条），也不会因为末尾多出的空行
            // 被 "当前行" 高亮整块染成灰带。
            selection: { anchor: caret },
            // 建议可能追加在文末很远的位置：显式把这段滚进视野，别让用户以为没生成。
            effects: EditorView.scrollIntoView(caret, { y: "center" }),
            userEvent: "input.ai.preview",
            annotations: Transaction.addToHistory.of(false),
        });
        proposal.current = {
            ...latest, text:previewText,
            from: previewFrom,
            to: previewFrom + previewText.length,
            id: uid(),
            reason: result.reason || defaultReason,
            mode: requestMode,
            count: visibleCount(previewText),
            node,
            writingNodeId: requestMode === "outline" ? currentWritingNode?.id : undefined,
            creatingHeading: !!newNodeHeading,
        };
        openPanel(activeSession.current);
        add("assistant", `${config.demo ? "【交互演示】" : ""}已把「${node}」的${requestMode === "outline" ? "节点正文" : "新一段"}放进正文预览，共 ${visibleCount(previewText)} 字，还没有写入磁盘。点这段上方的 ✓ 保留，✗ 撤掉。`, { documentFile });
        redraw();
    }
    catch (e) {
        if (generation.current === id && (e as Error).name !== "AbortError") {
            setError((e as Error).message);
            if (usesPrompt)
                setPrompt(old => old || userPrompt);
            add("system", `本轮未完成：${(e as Error).message} 正文未改动。`);
        }
    }
    finally {
        if (generation.current === id) {
            running.current = false;
            setBusy(false);
            setStream("");
            controller.current = null;
            requestAnchor.current = null;
            if (origin) origin.current = null;
        }
    }
}
