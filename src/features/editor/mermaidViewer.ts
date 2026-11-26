import {createUiIcon} from '../../shared/icons';
import {getMermaidZoomGesture} from '../settings/shortcutStorage';
import './mermaidViewer.css';

type ViewPosition = {scale:number; fit:boolean; left:number; top:number};
type Point={x:number;y:number};
const raisedBoards=new WeakMap<Document,HTMLElement>();

function pointerDrag(handle:HTMLElement,start:(event:PointerEvent)=>((dx:number,dy:number)=>void)|undefined){
  let active:{pointer:number;x:number;y:number;move:(dx:number,dy:number)=>void}|undefined;
  function reset(){
    if(!active)return;
    const {pointer}=active;
    active=undefined;
    handle.classList.remove('is-dragging');
    if(handle.hasPointerCapture(pointer))handle.releasePointerCapture(pointer);
  }
  handle.addEventListener('pointerdown',event=>{
    if(active||!event.isPrimary||event.button!==0||event.ctrlKey)return;
    const move=start(event);
    if(!move)return;
    event.preventDefault();
    event.stopPropagation();
    active={pointer:event.pointerId,x:event.clientX,y:event.clientY,move};
    handle.setPointerCapture(event.pointerId);
    handle.classList.add('is-dragging');
  });
  handle.addEventListener('pointermove',event=>{
    if(active?.pointer===event.pointerId){
      if(event.buttons&1)active.move(event.clientX-active.x,event.clientY-active.y);
      else reset();
    }
  });
  const finish=(event:PointerEvent)=>{if(active?.pointer===event.pointerId)reset();};
  handle.addEventListener('pointerup',event=>{
    if(active?.pointer!==event.pointerId||event.button!==0)return;
    active.move(event.clientX-active.x,event.clientY-active.y);
    reset();
  });
  handle.addEventListener('pointercancel',finish);
  handle.addEventListener('lostpointercapture',finish);
  return reset;
}

export function mountMermaidViewer(slot:HTMLElement, svg:SVGSVGElement, editorScroller:HTMLElement) {
  const doc=slot.ownerDocument, win=doc.defaultView!;
  const box=svg.viewBox.baseVal;
  const width=box.width || svg.getBoundingClientRect().width || 1;
  const height=box.height || svg.getBoundingClientRect().height || 1;
  const viewer=doc.createElement('section'), toolbar=doc.createElement('div'), viewport=doc.createElement('div');
  const canvas=doc.createElement('div'), percent=doc.createElement('span');
  const board=doc.createElement('section'), header=doc.createElement('header'), title=doc.createElement('b');
  const close=doc.createElement('button');
  viewer.className='mermaid-viewer';
  viewer.setAttribute('aria-label','Mermaid 图表查看器');
  toolbar.className='mermaid-controls';
  viewport.className='mermaid-viewport';
  viewport.tabIndex=0;
  viewport.setAttribute('role','region');
  viewport.setAttribute('aria-label','Mermaid 图表，拖动平移');
  viewport.style.setProperty('--diagram-height',height+'px');
  canvas.className='mermaid-canvas';
  board.className='mermaid-board';
  board.setAttribute('role','dialog');
  board.setAttribute('aria-label','Mermaid 看板');
  header.className='mermaid-board-title independent-panel-header panel-drag-header';
  title.textContent='Mermaid 看板';
  close.type='button';
  close.className='panel-mini-button';
  close.title='关闭 Mermaid 看板';
  close.setAttribute('aria-label',close.title);
  close.append(createUiIcon(doc,'X',14));
  header.append(title,close);
  board.append(header);
  svg.setAttribute('role','img');
  svg.setAttribute('aria-label','Mermaid 图表');
  // Mermaid assigns a max-width in the SVG's own style. The viewer now owns its size.
  svg.style.maxWidth='none';
  slot.removeAttribute('role');
  slot.removeAttribute('aria-label');
  canvas.append(svg);
  viewport.append(canvas);
  viewer.append(toolbar,viewport);
  slot.replaceChildren(viewer);

  let scale=1, fit=true, saved:ViewPosition|undefined;
  let pan:Point={x:0,y:0};
  function setPan(x:number,y:number){
    pan={x,y};
    svg.style.translate=`${x}px ${y}px`;
  }
  function placeBoard(left:number,top:number){
    const root=doc.documentElement;
    const maxX=Math.max(0,root.clientWidth-board.offsetWidth);
    const maxY=Math.max(0,root.clientHeight-board.offsetHeight);
    board.style.left=Math.min(maxX,Math.max(0,left))+'px';
    board.style.top=Math.min(maxY,Math.max(0,top))+'px';
  }
  function keepBoardVisible(){
    if(board.isConnected)placeBoard(board.offsetLeft,board.offsetTop);
  }
  function button(label:string, content:string|SVGElement, run:()=>void) {
    const el=doc.createElement('button');
    el.type='button';el.append(content);el.title=label;el.setAttribute('aria-label',label);
    el.addEventListener('click',run);toolbar.append(el);
    return el;
  }
  function fitScale(){
    // offsetWidth/Height include traditional scrollbars. Once fitted, both go away.
    return Math.min(1,Math.max(1,viewport.offsetWidth-2)/width,Math.max(1,viewport.offsetHeight-2)/height);
  }
  function resize(next:number){
    scale=next;
    svg.style.width=width*scale+'px';svg.style.height=height*scale+'px';
    percent.textContent=Math.round(scale*100)+'%';
  }
  function fitImage(){
    fit=true;
    resize(fitScale());
    if(board.isConnected)setPan(0,0);
    viewport.scrollTo(0,0);
  }
  function zoom(next:number, clientX?:number, clientY?:number){
    const bounds=viewport.getBoundingClientRect(), before=svg.getBoundingClientRect();
    if(!before.width||!before.height)return;
    const x=clientX??(bounds.left+viewport.clientWidth/2), y=clientY??(bounds.top+viewport.clientHeight/2);
    const relativeX=(x-before.left)/before.width, relativeY=(y-before.top)/before.height;
    // Keep the fitted view reachable even for diagrams much bigger than the normal zoom range.
    const limit=Math.min(.1,fitScale());
    fit=false;resize(Math.min(8,Math.max(limit,next)));
    const after=svg.getBoundingClientRect();
    const dx=after.left+relativeX*after.width-x,dy=after.top+relativeY*after.height-y;
    if(board.isConnected)setPan(pan.x-dx,pan.y-dy);
    else viewport.scrollBy(dx,dy);
  }
  button('缩小 Mermaid 图表',createUiIcon(doc,'Minus',12),()=>zoom(scale/1.25));
  percent.className='mermaid-zoom-value';toolbar.append(percent);
  button('放大 Mermaid 图表',createUiIcon(doc,'Plus',12),()=>zoom(scale*1.25));
  button('适应窗口','适应窗口',fitImage);
  button('按实际大小显示','原大',()=>zoom(1));
  const expand=button('展开 Mermaid 看板','展开看板',()=>{
    if(board.isConnected){raiseBoard();close.focus({preventScroll:true});return;}
    saved={scale,fit,left:viewport.scrollLeft,top:viewport.scrollTop};
    cancelPan();
    slot.style.height=slot.getBoundingClientRect().height+'px';
    doc.body.append(board);board.append(viewer);expand.hidden=true;
    placeBoard((doc.documentElement.clientWidth-board.offsetWidth)/2,(doc.documentElement.clientHeight-board.offsetHeight)/2);
    raiseBoard();
    fitImage();
    close.focus({preventScroll:true});
  });
  function raiseBoard(){
    const previous=raisedBoards.get(doc);
    if(previous===board)return;
    if(previous)delete previous.dataset.mermaidRaised;
    raisedBoards.set(doc,board);
    board.dataset.mermaidRaised='';
  }
  function removeBoard(){
    if(raisedBoards.get(doc)===board)raisedBoards.delete(doc);
    delete board.dataset.mermaidRaised;
    board.remove();
  }
  function closeBoard(){
    if(!saved)return;
    cancelDrags();
    slot.append(viewer);slot.style.removeProperty('height');removeBoard();
    expand.hidden=false;
    svg.style.removeProperty('translate');
    fit=saved.fit;resize(fit?fitScale():saved.scale);viewport.scrollTo(saved.left,saved.top);
    saved=undefined;expand.focus({preventScroll:true});
  }
  close.addEventListener('click',closeBoard);
  board.addEventListener('pointerdown',raiseBoard,true);
  board.addEventListener('focusin',raiseBoard);
  board.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeBoard();}
  });
  viewport.addEventListener('wheel',event=>{
    const unit=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1;
    if(event.ctrlKey||getMermaidZoomGesture()==='wheel'){
      if(!event.deltaY)return;
      event.preventDefault();event.stopPropagation();
      zoom(scale*Math.exp(-Math.max(-400,Math.min(400,event.deltaY*unit))*.002),event.clientX,event.clientY);
    }else if(board.isConnected){
      event.preventDefault();event.stopPropagation();
      setPan(pan.x-event.deltaX*unit,pan.y-event.deltaY*unit);
    }else if(viewport.scrollHeight>viewport.clientHeight||viewport.scrollWidth>viewport.clientWidth){
      // A scrollable diagram would otherwise consume normal manuscript wheel scrolling.
      event.preventDefault();event.stopPropagation();
      editorScroller.scrollBy(event.deltaX*unit,event.deltaY*unit);
    }
  },{passive:false});
  // The inline view keeps its normal scrollbars. The board has independent pan
  // coordinates so the diagram can move even when it fits the whole canvas.
  const cancelPan=pointerDrag(canvas,()=>{
    viewport.focus({preventScroll:true});
    if(board.isConnected){
      const origin=pan;
      return (dx,dy)=>setPan(origin.x+dx,origin.y+dy);
    }
    const {scrollLeft,scrollTop}=viewport;
    return (dx,dy)=>viewport.scrollTo(scrollLeft-dx,scrollTop-dy);
  });
  const cancelMove=pointerDrag(header,event=>{
    if((event.target as Element).closest('button'))return;
    const {offsetLeft,offsetTop}=board;
    return (dx,dy)=>placeBoard(offsetLeft+dx,offsetTop+dy);
  });
  function cancelDrags(){cancelPan();cancelMove();}
  win.addEventListener('blur',cancelDrags);
  win.addEventListener('resize',keepBoardVisible);
  let resizeFrame=0;
  const observer=new win.ResizeObserver(()=>{
    if(resizeFrame)return;
    resizeFrame=win.requestAnimationFrame(()=>{
      resizeFrame=0;
      if(fit)resize(fitScale());
      keepBoardVisible();
    });
  });
  observer.observe(viewport);
  fitImage();
  return ()=>{
    observer.disconnect();
    win.cancelAnimationFrame(resizeFrame);
    win.removeEventListener('blur',cancelDrags);
    win.removeEventListener('resize',keepBoardVisible);
    cancelDrags();
    removeBoard();
  };
}
