import {Direction,RectangleMarker,layer} from '@codemirror/view';
import {annotationHighlights} from './annotationDecorations';

type Box=Pick<DOMRectReadOnly,'left'|'top'|'right'|'bottom'>;
function mergeAnnotationBounds(current:Box|undefined,next:Box):Box{
  if(!current)return {left:next.left,top:next.top,right:next.right,bottom:next.bottom};
  return {left:Math.min(current.left,next.left),top:Math.min(current.top,next.top),right:Math.max(current.right,next.right),bottom:Math.max(current.bottom,next.bottom)};
}

class AnnotationFrameMarker extends RectangleMarker {
  constructor(readonly annotationId:string,left:number,top:number,width:number,height:number){
    super('cm-text-annotation-frame',left,top,width,height);
  }
  draw(){
    const element=super.draw();
    element.dataset.annotationFrameId=this.annotationId;
    return element;
  }
  eq(other:RectangleMarker){return other instanceof AnnotationFrameMarker&&this.annotationId===other.annotationId&&super.eq(other);}
  update(element:HTMLElement,other:RectangleMarker){
    return other instanceof AnnotationFrameMarker&&this.annotationId===other.annotationId&&super.update(element,other);
  }
}

/** The text marks still provide hover, keyboard focus and annotation IDs. A separate layer
 * draws one background for all rendered fragments belonging to the same source selection. */
export const annotationFrames=layer({
  above:false,
  class:'cm-annotation-layer',
  update:update=>update.viewportChanged||update.startState.field(annotationHighlights)!==update.state.field(annotationHighlights),
  markers(view){
    if(!view.state.field(annotationHighlights).size)return [];
    const bounds=new Map<string,Box>();
    for(const mark of view.contentDOM.querySelectorAll<HTMLElement>('.cm-text-annotation[data-annotation-id]')){
      const id=mark.dataset.annotationId!;
      for(const rect of mark.getClientRects()){
        if(rect.width>0&&rect.height>0)bounds.set(id,mergeAnnotationBounds(bounds.get(id),rect));
      }
    }
    if(!bounds.size)return [];
    const scroll=view.scrollDOM,rect=scroll.getBoundingClientRect();
    const startX=(view.textDirection===Direction.LTR?rect.left:rect.right-scroll.clientWidth*view.scaleX)-scroll.scrollLeft*view.scaleX;
    const startY=rect.top-scroll.scrollTop*view.scaleY;
    const padding=2;
    return [...bounds].map(([id,box])=>new AnnotationFrameMarker(
      id,box.left-startX-padding,box.top-startY-padding,
      box.right-box.left+2*padding,box.bottom-box.top+2*padding,
    ));
  },
});
