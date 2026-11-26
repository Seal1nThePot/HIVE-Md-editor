import {EditorState} from '@codemirror/state';
import type {EditorView} from '@codemirror/view';
import {describe,expect,it,vi} from 'vitest';
import {freezeWorkspaceInput} from './freezeWorkspaceInput';

function editor(text:string) {
  let state = EditorState.create({doc:text});
  const view = {
    dom:{isConnected:true},
    get state(){return state;},
    dispatch(changes:Parameters<EditorView['dispatch']>[0]) {
      state = state.update(changes).state;
    },
  };
  const events = new EventTarget();
  const focus = {isConnected:true,focus:vi.fn()};
  const body = {inert:false};
  const document = Object.assign(events,{body,activeElement:focus}) as unknown as Document;
  return {view,document,focus,body,events};
}

describe('workspace commit input guard',()=>{
  it('blocks paste, keyboard events and programmatic text edits in every live editor until release',()=>{
    const main=editor('main'), child=editor('child');
    const release=freezeWorkspaceInput([main.document,child.document],[main.view,child.view] as unknown as EditorView[]);
    for (const item of [main,child]) {
      expect(item.body.inert).toBe(true);
      for(const name of ['keydown','paste','drop','beforeinput']){
        const event=new Event(name,{cancelable:true});
        expect(item.events.dispatchEvent(event)).toBe(false);
      }
      item.view.dispatch({changes:{from:0,insert:'blocked-'},userEvent:'input.type'});
      expect(item.view.state.doc.toString()).not.toContain('blocked-');
    }
    release(true);release(true);
    for (const item of [main,child]) {
      expect(item.body.inert).toBe(false);
      expect(item.focus.focus).toHaveBeenCalledTimes(1);
      expect(item.events.dispatchEvent(new Event('drop',{cancelable:true}))).toBe(true);
      item.view.dispatch({changes:{from:0,insert:'allowed-'},userEvent:'input.type'});
      expect(item.view.state.doc.toString()).toContain('allowed-');
    }
  });
});
