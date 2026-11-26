import type {EditorState} from '@codemirror/state';
import type {EditorStatusContribution} from '../settings/usePlugins';

function valueFor(state:EditorState, metric:EditorStatusContribution['metric']) {
  const {doc,selection} = state;
  if (metric === 'document-lines') return doc.lines;
  if (metric === 'line-length') {
    let length = 0;
    for (const _character of doc.lineAt(selection.main.head).text) length++;
    return length;
  }
  let count = 0;
  let lastLine = 0;
  for (const range of selection.ranges) {
    if (range.empty) continue;
    const first = Math.max(doc.lineAt(range.from).number, lastLine + 1);
    const last = doc.lineAt(range.to - 1).number;
    count += Math.max(0, last - first + 1);
    lastLine = last;
  }
  return count;
}

export function StatusPluginItem({id,contribution,state}:{id:string;contribution:EditorStatusContribution;state:EditorState|null}) {
  const value = state ? valueFor(state,contribution.metric).toLocaleString() : '—';
  const text = `${contribution.label} ${value}`;
  return <span className="editor-status-plugin" data-plugin-id={id} title={text}>{text}</span>;
}
