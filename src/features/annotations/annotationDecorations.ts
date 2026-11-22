import { StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
export type AnnotationMark = {
  id: string;
  from: number;
  to: number;
  note: string;
};
export const setAnnotationMarks = StateEffect.define<AnnotationMark[]>();
export const annotationHighlights = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects)
      if (effect.is(setAnnotationMarks))
        value = Decoration.set(
          effect.value
            .filter(
              (item) =>
                item.from >= 0 &&
                item.to > item.from &&
                item.to <= tr.state.doc.length,
            )
            .map((item) =>
              Decoration.mark({
                class: "cm-text-annotation",
                attributes: {
                  "data-annotation-id": item.id,
                  tabindex: "0",
                  "aria-label": item.note || "文本标注",
                },
              }).range(item.from, item.to),
            ),
          true,
        );
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function hideAnnotationSelection(state:EditorState,visibleIds:ReadonlySet<string>){
  const marks=state.field(annotationHighlights,false);
  const selected=state.selection.ranges.filter(range=>!range.empty);
  return !!marks&&selected.length>0&&selected.every(range=>{
    let annotated=false, visible=false;
    marks.between(range.from,range.to,(from,to,decoration)=>{
      if(from!==range.from||to!==range.to)return;
      annotated=true;
      visible ||= visibleIds.has(decoration.spec.attributes['data-annotation-id']);
    });
    return annotated&&!visible;
  });
}
