import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { DiskFile } from '../../shared/fileTypes';
import type { AnnotationContext } from '../editor/EditorContextMenu';
import type { GenerationOptions } from '../chat/writingGeneration';
import type { InlineAnnotationRequest } from './InlineAnnotationEditor';
import type { TextAnnotation, AnnotationSource } from './annotations';
import type { useTextAnnotations } from './useTextAnnotations';

const uid = () => crypto.randomUUID();

type AnnotationActionsOptions = {
    annotations: ReturnType<typeof useTextAnnotations>;
    view: RefObject<EditorView | null>;
    scratchView: RefObject<EditorView | null>;
    activeTextSource: RefObject<AnnotationSource>;
    disk: RefObject<DiskFile | null>;
    file: string;
    activeSession: RefObject<string>;
    workspace: { open: (id: string) => void };
    chooseSidebar: (id: 'outline' | 'files' | 'scratch') => void;
    setError: (message: string) => void;
    setInlineRequest: Dispatch<SetStateAction<InlineAnnotationRequest | null>>;
    setAnnotationFocus: (id: string) => void;
    generate: (options?: GenerationOptions) => unknown;
    openChat: (tab?: 'conversation' | 'annotations') => void;
    annotationInstruction: string;
    onCancelAnnotations?: (ids:string[]) => void;
};

/** 正文/草稿上的标注动作：标记、取消、定位、重锚，以及把标注连同指示发给 AI。 */
export function useAnnotationActions({ annotations, view, scratchView, activeTextSource, disk, file, activeSession, workspace, chooseSidebar, setError, setInlineRequest, setAnnotationFocus, generate, openChat, annotationInstruction, onCancelAnnotations }: AnnotationActionsOptions) {
    const [pendingAnnotationContext, setPendingAnnotationContext] = useState<{ source: AnnotationSource; file: string; editor: EditorView; doc: EditorView['state']['doc']; context: AnnotationContext } | null>(null);
    function markText(source: AnnotationSource = activeTextSource.current, expectedFile = source === 'document' ? disk.current?.path : undefined) {
        try {
            const id = annotations.mark(source, expectedFile);
            setAnnotationFocus(id);
            setInlineRequest({ id, ids: [...annotations.lastMarkedIds.current], nonce: uid(), focus: true });
        }
        catch (error) {
            setError((error as Error).message);
        }
    }
    function showLocalAnnotation(source: AnnotationSource, context: AnnotationContext, expectedFile?: string) {
        const editor = source === 'document' ? view.current : scratchView.current;
        if (!editor)
            return;
        setPendingAnnotationContext({ source, file: source === 'document' ? expectedFile || '' : '自由草稿', editor, doc: editor.state.doc, context });
    }
    useEffect(() => {
        const pending = pendingAnnotationContext;
        if (!pending)
            return;
        const editor = pending.source === 'document' ? view.current : scratchView.current;
        if (editor !== pending.editor || editor.state.doc !== pending.doc) {
            setPendingAnnotationContext(null);
            setError('选区或正文已变化，请重新选择。');
            return;
        }
        if (pending.source === 'document' && (file !== pending.file || !annotations.ready))
            return;
        const nonempty = pending.context.ranges.filter(range => range.to > range.from);
        const matches = annotations.items.filter(item => item.source === pending.source && item.file === pending.file && !item.stale && (nonempty.length ? nonempty.some(range => item.from < range.to && item.to > range.from) : pending.context.ids.length ? pending.context.ids.includes(item.id) : pending.context.ranges.some(range => item.from <= range.from && range.from < item.to)));
        setPendingAnnotationContext(null);
        if (matches.length) {
            const item = matches[0];
            setInlineRequest({ id: item.id, nonce: uid(), focus: false });
            return;
        }
        if (nonempty.length) {
            editor.dispatch({ selection: EditorSelection.create(nonempty.map(range => EditorSelection.range(range.from, range.to))) });
            markText(pending.source, pending.source === 'document' ? pending.file : undefined);
            return;
        }
        setError('请先选择文字或在已有标注处打开。');
    }, [pendingAnnotationContext, file, annotations.items, annotations.ready]);
    function unmarkText(source: AnnotationSource = activeTextSource.current, annotationId?: string, expectedFile = source === 'document' ? disk.current?.path : undefined) {
        try {
            annotations.unmark(source, annotationId, expectedFile);
            setInlineRequest(null);
        }
        catch (error) {
            setError((error as Error).message);
        }
    }
    function cancelAnnotations(ids:string[]) {
        const removed = annotations.items.filter(item => ids.includes(item.id));
        if (!removed.length) return;
        const removedIds = removed.map(item => item.id);
        onCancelAnnotations?.(removedIds);
        annotations.removeMany(removedIds);
        setInlineRequest(current => current && [current.id, ...(current.ids ?? [])].some(id => removedIds.includes(id)) ? null : current);
        for (const source of ['document', 'scratch'] as const) {
            const editor = source === 'document' ? view.current : scratchView.current;
            if (!editor) continue;
            const { selection } = editor.state;
            const exact = removed.filter(item => item.source === source && !item.stale);
            const ranges = selection.ranges.map(range => exact.some(item => range.from === item.from && range.to === item.to)
                ? EditorSelection.cursor(range.head) : range);
            const next = EditorSelection.create(ranges, selection.mainIndex);
            if (!selection.eq(next)) editor.dispatch({ selection:next });
        }
    }
    function locateAnnotation(item: TextAnnotation) {
        try {
            if (item.source === "scratch") {
                chooseSidebar("scratch");
            }
            else
                workspace.open(activeSession.current);
            if (item.stale) {
                const editor = item.source === 'scratch' ? scratchView.current : view.current;
                if (editor) {
                    const pos = Math.min(item.from, editor.state.doc.length);
                    editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
                    editor.focus();
                }
            }
            else
                annotations.locate(item);
            setInlineRequest({ id: item.id, nonce: uid(), focus: false });
        }
        catch (error) {
            setError((error as Error).message);
        }
    }
    function reanchorAnnotation(item: TextAnnotation) {
        try {
            annotations.reanchor(item);
        }
        catch (error) {
            setError((error as Error).message);
        }
    }
    function sendAnnotations(ids: string[]) {
        try {
            const submitted = annotations.submission(ids);
            openChat("conversation");
            void generate({ annotations: submitted, instruction: annotationInstruction });
        }
        catch (error) {
            setError((error as Error).message);
        }
    }
    return { markText, showLocalAnnotation, unmarkText, locateAnnotation, reanchorAnnotation, sendAnnotations, cancelAnnotations };
}
