import type { EditorState, StateEffect, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { DiskFile } from '../../shared/fileTypes';
import type { Proposal, UndoEdit } from '../../shared/core';
import type { EditorDisplayMode } from './splitView';
import type { TrashDocument } from '../files/TrashDocumentPreview';
export const trashPreviewTabPrefix='editor:trash-';
export type EditorSession = {
    id: string;
    disk: DiskFile | null;
    imagePath?: string;
    trashPreview?: TrashDocument;
    external?: {disk: DiskFile; editable: boolean};
    state: EditorState | null;
    view: EditorView | null;
    dirty: boolean;
    contentVersion?:number;
    restoreScroll?: number;
    restoreScrollLeft?: number;
    restoreScrollTarget?: { doc: Text; effect: StateEffect<unknown> };
    typewriter?: boolean;
    displayMode?: EditorDisplayMode;
    landing?: boolean;
    context?: {
        proposal: Proposal | null;
        undo: UndoEdit[];
        writingNodeId: string | null;
    };
};
