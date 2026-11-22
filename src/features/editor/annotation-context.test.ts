import {describe,it,expect} from 'vitest';
import {EditorState} from '@codemirror/state';
import {decodedOffsets} from './EditorContextMenu';
import {annotationHighlights,hideAnnotationSelection,setAnnotationMarks} from '../annotations/annotationDecorations';
describe('table text selection source mapping',()=>{
  it('maps decoded escaped pipes, backslashes and line breaks to original offsets',()=>{
    const raw=String.raw`a\|b\\c<br>d`;
    expect(decodedOffsets(raw)).toEqual([0,1,3,4,6,7,11,12]);
  });
  it('handles an empty cell',()=>expect(decodedOffsets('')).toEqual([0]));
});

describe('temporarily hidden annotation selections',()=>{
  it('uses only matching marks from the selected editor and keeps the real selection',()=>{
    const first=EditorState.create({doc:'一段正文',selection:{anchor:0,head:2},extensions:[annotationHighlights]});
    const marked=first.update({effects:setAnnotationMarks.of([{id:'a',from:0,to:2,note:'批注'}])}).state;
    const other=EditorState.create({doc:'另一文稿',selection:{anchor:0,head:2},extensions:[annotationHighlights]});
    expect(hideAnnotationSelection(marked,new Set())).toBe(true);
    expect(hideAnnotationSelection(marked,new Set(['a']))).toBe(false);
    expect(marked.selection.eq(first.selection)).toBe(true);
    expect(hideAnnotationSelection(other,new Set())).toBe(false);
  });
});
