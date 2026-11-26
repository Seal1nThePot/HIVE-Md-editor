import {Compartment,EditorState,StateEffect} from '@codemirror/state';
import type {EditorView} from '@codemirror/view';

const barrier = new Compartment();
const readOnlyChanges = EditorState.changeFilter.of(transaction=>!transaction.docChanged || transaction.isUserEvent('input.disk-sync'));
const inputEvents = ['beforeinput','input','change','paste','drop'];

export function freezeWorkspaceInput(documents:readonly Document[], views:readonly EditorView[]) {
  const stop = (event:Event) => {event.preventDefault();event.stopImmediatePropagation();};
  const bodies = [...new Set(documents)].map(document=>({document,body:document.body,inert:document.body.inert,
    focus:document.activeElement as HTMLElement|null}));
  const guarded:EditorView[] = [];
  let released = false;
  function release(restoreFocus:boolean) {
    if (released) return;
    released = true;
    for (const {document,body,inert,focus} of bodies) {
      body.inert = inert;
      for (const name of inputEvents) document.removeEventListener(name,stop,true);
      if (restoreFocus && !inert && focus?.isConnected && focus!==body) focus.focus({preventScroll:true});
    }
    for (const view of guarded) if (view.dom.isConnected) view.dispatch({effects:barrier.reconfigure([])});
  }
  try {
    for (const {document,body} of bodies) {
      for (const name of inputEvents) document.addEventListener(name,stop,true);
      body.inert = true;
    }
    for (const view of new Set(views)) {
      const effect = barrier.get(view.state) ? barrier.reconfigure(readOnlyChanges) : StateEffect.appendConfig.of(barrier.of(readOnlyChanges));
      guarded.push(view);
      view.dispatch({effects:effect});
    }
  } catch (error) {
    release(true);
    throw error;
  }
  return release;
}
