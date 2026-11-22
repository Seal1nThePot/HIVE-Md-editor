import {afterEach,describe,it,expect,vi} from 'vitest';
import {EditorState,type Transaction} from '@codemirror/state';
import {history,undo,redo} from '@codemirror/commands';
import {deferredEditorSleep,editorSleepDelay} from './editorSleep';
import {captureEditorView} from './editorViewSnapshot';
import {panelIsVisible} from '../../shared/panelActivity';
import type {EditorSession} from './editorSessionTypes';

const clock={set:(callback:()=>void,delay:number)=>setTimeout(callback,delay),clear:(id:unknown)=>clearTimeout(id as ReturnType<typeof setTimeout>)};
afterEach(()=>vi.useRealTimers());
describe('background editor lifecycle',()=>{
  it('cancels sleep during quick tab switches and does not run a disposed timer',()=>{
    vi.useFakeTimers();const sleep=vi.fn(),control=deferredEditorSleep(clock,sleep,()=>false);
    control.visible(false);vi.advanceTimersByTime(editorSleepDelay-1);control.visible(true);vi.advanceTimersByTime(1000);expect(sleep).not.toHaveBeenCalled();
    control.visible(false);vi.advanceTimersByTime(editorSleepDelay);expect(sleep).toHaveBeenCalledOnce();
    control.visible(true);control.visible(false);control.dispose();vi.runAllTimers();expect(sleep).toHaveBeenCalledOnce();
  });
  it('keeps a native composition or gesture until released, without polling in the background',()=>{
    vi.useFakeTimers();let protectedInput=true;const sleep=vi.fn(),control=deferredEditorSleep(clock,sleep,()=>protectedInput);
    control.visible(false);vi.advanceTimersByTime(1000);expect(sleep).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    protectedInput=false;control.released();vi.advanceTimersByTime(editorSleepDelay);expect(sleep).toHaveBeenCalledOnce();
  });
  it('treats each native host and each active tab independently, including multiple simultaneously visible editors',()=>{
    expect(panelIsVisible(true,true,false,null,false,false)).toBe(true);
    expect(panelIsVisible(true,false,false,null,false,false)).toBe(false);
    expect(panelIsVisible(true,false,true,true,false,false)).toBe(true);
    expect(panelIsVisible(true,false,true,false,false,false)).toBe(false);
    expect(panelIsVisible(true,true,true,true,true,false)).toBe(false);
    expect(panelIsVisible(true,true,false,null,false,true)).toBe(false);
    expect(panelIsVisible(false,true,false,null,false,false)).toBe(false);
  });
  it('keeps the original state, selection and undo/redo after view disposal, without flattening the text',()=>{
    let state=EditorState.create({doc:'original',extensions:history()});state=state.update({changes:{from:8,insert:' UNSAVED'},selection:{anchor:12},userEvent:'input.type'}).state;
    const text=vi.spyOn(state.doc,'toString');let visible=true;
    const effect={};
    const session:EditorSession={id:'editor:test',disk:null,dirty:true,state:null,view:{state,dom:{getClientRects:()=>visible?[{}]:[]},scrollDOM:{scrollTop:240,scrollLeft:36},scrollSnapshot:()=>effect} as unknown as EditorSession['view']};
    captureEditorView(session);visible=false;session.view!.scrollDOM.scrollTop=0;session.view!.scrollDOM.scrollLeft=0;captureEditorView(session);session.view=null;
    expect(session.state).toBe(state);expect(session.state?.selection.main.head).toBe(12);expect([session.restoreScroll,session.restoreScrollLeft]).toEqual([240,36]);expect(session.dirty).toBe(true);expect(text).not.toHaveBeenCalled();
    expect(session.restoreScrollTarget).toEqual({doc:state.doc,effect});
    state=session.state!;const dispatch=(tr:Transaction)=>{state=tr.state;};expect(undo({state,dispatch})).toBe(true);expect(state.sliceDoc()).toBe('original');expect(redo({state,dispatch})).toBe(true);expect(state.sliceDoc()).toBe('original UNSAVED');
  });
});
