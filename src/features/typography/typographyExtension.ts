import {StateEffect,Transaction,type Extension} from '@codemirror/state';
import {EditorView,ViewPlugin} from '@codemirror/view';
import {getTypographySnapshot,subscribeTypography} from './typographyStore';
import type {TypographyPreferences} from './typographyPreferences';
import {typographyUpdateQueue} from './typographyUpdateQueue';
import {typographyTheme} from './typographyTheme';

function applyStyles(view:EditorView,preferences:TypographyPreferences){
  const compact=preferences.tableDensity!=='standard';
  view.dom.style.setProperty('--hive-table-line-height',compact?'1.35':'1.55');
  view.dom.style.setProperty('--hive-table-padding-y',compact?'.2em':'.4em');
  view.dom.style.setProperty('--hive-table-padding-x',compact?'.4em':'.8em');
  view.dom.style.setProperty('--hive-max-width',preferences.maxWidth+'px');
  view.dom.style.setProperty('--hive-line-height',String(preferences.lineHeight));
  view.dom.style.setProperty('--hive-paragraph-spacing',preferences.paragraphSpacing+'em');
  view.dom.style.setProperty('--hive-first-indent',preferences.firstLineIndent?'2em':'0em');
}
const typographyView=ViewPlugin.define(view=>{
  let composing=false;
  let releaseTimer:ReturnType<typeof setTimeout>|undefined;
  const queue=typographyUpdateQueue<TypographyPreferences>({
    composing:()=>composing||view.composing,
    // Timers remain valid when a pane's DOM is moved to another native document.
    schedule:callback=>setTimeout(callback,0),cancel:id=>clearTimeout(id as ReturnType<typeof setTimeout>),
    apply:preferences=>{
      const snapshot=view.scrollSnapshot();
      applyStyles(view,preferences);
      view.dispatch({effects:snapshot,annotations:Transaction.addToHistory.of(false)});
      view.requestMeasure();
    },
  });
  applyStyles(view,getTypographySnapshot().preferences);
  const unsubscribe=subscribeTypography(()=>queue.request(getTypographySnapshot().preferences));
  const start=()=>{composing=true;},end=()=>{
    composing=false;
    // Capture listeners run before CodeMirror clears its own composition flag.
    // Retry after the event and pending input microtasks, even if no ViewUpdate follows.
    clearTimeout(releaseTimer);releaseTimer=setTimeout(()=>queue.released(),0);
  };
  view.dom.addEventListener('compositionstart',start,true);view.dom.addEventListener('compositionend',end,true);
  return {update(){queue.released();},destroy(){unsubscribe();queue.dispose();clearTimeout(releaseTimer);view.dom.removeEventListener('compositionstart',start,true);view.dom.removeEventListener('compositionend',end,true);}};
});
export const typographyExtensions:Extension=[typographyTheme,typographyView,EditorView.contentAttributes.of({lang:'zh-CN'})];
export function configureTypography(view:EditorView){if(!view.plugin(typographyView))view.dispatch({effects:StateEffect.appendConfig.of(typographyExtensions)});}
