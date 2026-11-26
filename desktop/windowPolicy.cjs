function validCommand(value) { return value === 'minimize' || value === 'maximize' || value === 'close' || value === 'focus' || value === 'hide'; }
function allowNavigation(url, entry, loaded) { return !loaded && url === entry; }
function commandAllowed(command, isPanel, id) { return validCommand(command) && !(isPanel && command === 'maximize') && !(!isPanel && command === 'hide') && !(id === 'global-toolbar' && (command === 'minimize' || command === 'hide')); }
function readyPanels(windows, ready) { return [...windows.entries()].filter(([id, window]) => ready.has(id) && !window.isDestroyed()); }
function contentPoint(cursor, bounds, zoom) { const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1; return {x:(cursor.x-bounds.x)/scale,y:(cursor.y-bounds.y)/scale}; }
function nativePanelBounds(rect, contentBounds, zoom) {
  if(!rect||![rect.x,rect.y,rect.width,rect.height].every(value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=100000)||rect.width<=0||rect.height<=0)return null;
  const scale=Number.isFinite(zoom)&&zoom>0?zoom:1;
  return {x:Math.round(contentBounds.x+rect.x*scale),y:Math.round(contentBounds.y+rect.y*scale),width:Math.max(220,Math.round(rect.width*scale)),height:Math.max(140,Math.round(rect.height*scale))};
}
// Workspace rectangles are main-content CSS pixels. Electron content bounds
// are screen DIPs; Windows display scale is already handled by Electron.
function panelContentRect(bounds, contentBounds, zoom) {
  if(!bounds||![bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)||bounds.width<=0||bounds.height<=0)return null;
  const scale=Number.isFinite(zoom)&&zoom>0?zoom:1;
  return {x:(bounds.x-contentBounds.x)/scale,y:(bounds.y-contentBounds.y)/scale,width:bounds.width/scale,height:bounds.height/scale};
}
const resizeEdges = new Set(['n','s','e','w','ne','nw','se','sw']);
function dragAllowed(activeId, id, phase, ready, available, edge) {
  if (typeof id !== 'string' || !ready || !available || !['start','move','end','cancel'].includes(phase)) return false;
  if (edge !== undefined && (!resizeEdges.has(edge) || id === 'global-toolbar')) return false;
  return phase === 'start' ? activeId === null : activeId === id;
}
function dragPosition(bounds, start, cursor) { return {x:Math.round(bounds.x + cursor.x - start.x), y:Math.round(bounds.y + cursor.y - start.y)}; }
function dragBounds(bounds, start, cursor) { return {...dragPosition(bounds,start,cursor),width:bounds.width,height:bounds.height}; }
function withTargetSize(bounds, size) { return size ? {...bounds,width:size.width,height:size.height} : {...bounds}; }
function restoredPosition(maxBounds, normalBounds, cursor) {
  const ratio = Math.max(.1,Math.min(.9,(cursor.x-maxBounds.x)/Math.max(1,maxBounds.width)));
  const offset = Math.max(0,Math.min(32,cursor.y-maxBounds.y));
  return {x:Math.round(cursor.x-normalBounds.width*ratio),y:Math.round(cursor.y-offset)};
}
function toolbarPosition(base, area, previous) {
  const x = previous?.x ?? (base.x + (base.width-352)/2), y = previous?.y ?? (base.y + base.height-104-24);
  return {x:Math.round(Math.max(area.x,Math.min(x,area.x+Math.max(0,area.width-352)))),y:Math.round(Math.max(area.y,Math.min(y,area.y+Math.max(0,area.height-104))))};
}
function resizeBounds(bounds, start, cursor, edge, minWidth = 220, minHeight = 140) {
  const dx = Math.round(cursor.x-start.x), dy = Math.round(cursor.y-start.y);
  let {x,y,width,height} = bounds;
  if (edge.includes('e')) width = Math.max(minWidth,bounds.width+dx);
  if (edge.includes('s')) height = Math.max(minHeight,bounds.height+dy);
  if (edge.includes('w')) { width = Math.max(minWidth,bounds.width-dx); x = bounds.x+bounds.width-width; }
  if (edge.includes('n')) { height = Math.max(minHeight,bounds.height-dy); y = bounds.y+bounds.height-height; }
  return {x,y,width,height};
}
const dockingColorFields=require('./docking-colors.json');
function dockFeedback(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.guides) || value.guides.length > 16) throw new Error('Invalid dock feedback');
  const rect = input => {
    if (!input || typeof input !== 'object') throw new Error('Invalid dock rectangle');
    const {x,y,width,height} = input;
    if (![x,y,width,height].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100000) || width < 0 || height < 0) throw new Error('Invalid dock rectangle');
    return {x,y,width,height};
  };
  const guides = value.guides.map(item => {
    if (!item || typeof item.key !== 'string' || item.key.length > 80 || typeof item.label !== 'string' || item.label.length > 32) throw new Error('Invalid dock guide');
    return {key:item.key,label:item.label,button:rect(item.button)};
  });
  let ready = null;
  if (value.ready != null) { ready = {preview:rect(value.ready.preview)}; if (value.ready.button != null) ready.button = rect(value.ready.button); }
  let rail;
  if (value.rail != null) { if (!['left','right'].includes(value.rail.edge)) throw new Error('Invalid rail'); rail = {edge:value.rail.edge,rect:rect(value.rail.rect)}; }
  let colors;
  if(value.colors!==undefined){
    if(!value.colors||typeof value.colors!=='object'||Array.isArray(value.colors))throw new Error('Invalid docking colors');colors={};
    for(const [key,field] of Object.entries(dockingColorFields))if(value.colors[key]!==undefined){const color=value.colors[key];if(typeof color!=='string'||!(field.alpha?/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i:/^#[0-9a-f]{6}$/i).test(color))throw new Error('Invalid docking color');colors[key]=color.toLowerCase();}
  }
  const host=typeof value.host==='string'&&/^[a-zA-Z0-9_:.-]{1,128}$/.test(value.host)?value.host:undefined;
  return {guides,ready,...(host?{host}:{}),...(rail ? {rail} : {}),...(colors?{colors}:{})};
}
module.exports = { validCommand, allowNavigation, commandAllowed, readyPanels, contentPoint, nativePanelBounds, panelContentRect, dragAllowed, dragPosition, dragBounds, withTargetSize, restoredPosition, toolbarPosition, resizeBounds, dockFeedback };
