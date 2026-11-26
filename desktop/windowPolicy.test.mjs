import { describe, it, expect } from 'vitest';
import policy from './windowPolicy.cjs';
describe('desktop window policy', () => {
  it('allows only exact initial entry before load', () => {
    const entry='http://127.0.0.1:4321/?panelWindow=scratch';
    expect(policy.allowNavigation(entry,entry,false)).toBe(true);
    expect(policy.allowNavigation(entry,entry,true)).toBe(false);
    expect(policy.allowNavigation('http://127.0.0.1:4321/?panelWindow=other',entry,false)).toBe(false);
    expect(policy.allowNavigation('https://example.com/',entry,false)).toBe(false);
  });
  it('limits commands to window actions', () => {
    for (const command of ['minimize','maximize','close','focus','hide']) expect(policy.validCommand(command)).toBe(true);
    for (const command of ['destroy','reload','',null]) expect(policy.validCommand(command)).toBe(false);
  });
  it('disables panel maximize but keeps main maximize and filters unready windows', () => {
    expect(policy.commandAllowed('maximize', true)).toBe(false);
    expect(policy.commandAllowed('maximize', false)).toBe(true);
    expect(policy.commandAllowed('focus', true)).toBe(true);
    expect(policy.commandAllowed('minimize', true, 'global-toolbar')).toBe(false);
    expect(policy.commandAllowed('hide', true, 'global-toolbar')).toBe(false);
    expect(policy.commandAllowed('hide', true, 'conversation')).toBe(true);
    expect(policy.commandAllowed('hide', false)).toBe(false);
    const windows = new Map([['ready',{isDestroyed:()=>false}],['loading',{isDestroyed:()=>false}],['gone',{isDestroyed:()=>true}]]);
    expect(policy.readyPanels(windows,new Set(['ready','gone'])).map(([id])=>id)).toEqual(['ready']);
  });
  it('converts screen DIP to main content CSS coordinates with zoom', () => {
    expect(policy.contentPoint({x:1200,y:350},{x:1000,y:250},2)).toEqual({x:100,y:50});
    expect(policy.contentPoint({x:-300,y:60},{x:100,y:100},1)).toEqual({x:-400,y:-40});
  });
  it('places a native panel beyond the main window and on negative-coordinate monitors',()=>{
    expect(policy.nativePanelBounds({x:-1200,y:300,width:500,height:400},{x:200,y:100},1)).toEqual({x:-1000,y:400,width:500,height:400});
    expect(policy.nativePanelBounds({x:1300,y:-200,width:500,height:400},{x:200,y:100},1.25)).toEqual({x:1825,y:-150,width:625,height:500});
    for(const value of [{x:NaN,y:0,width:100,height:200},{x:0,y:0,width:-10,height:200},null])expect(policy.nativePanelBounds(value,{x:0,y:0},1)).toBeNull();
  });
  it('accepts only a ready window and the active drag id and phase', () => {
    expect(policy.dragAllowed(null,'files','start',true,true)).toBe(true);
    expect(policy.dragAllowed(null,'files','move',true,true)).toBe(false);
    expect(policy.dragAllowed('files','files','start',true,true)).toBe(false);
    expect(policy.dragAllowed('files','other','end',true,true)).toBe(false);
    expect(policy.dragAllowed('files','files','end',true,true)).toBe(true);
    expect(policy.dragAllowed('files','files','cancel',true,true)).toBe(true);
    expect(policy.dragAllowed(null,'files','start',false,true)).toBe(false);
    expect(policy.dragAllowed(null,'files','start',true,false)).toBe(false);
    expect(policy.dragAllowed(null,'files','delete',true,true)).toBe(false);
    expect(policy.dragPosition({x:-150,y:200},{x:100,y:50},{x:150,y:10})).toEqual({x:-100,y:160});
    expect(policy.dragBounds({x:-150,y:200,width:352,height:107},{x:100,y:50},{x:150,y:10})).toEqual({x:-100,y:160,width:352,height:107});
    expect(policy.dragAllowed(null,'files','start',true,true,'bad')).toBe(false);
    expect(policy.dragAllowed(null,'global-toolbar','start',true,true,'se')).toBe(false);
    expect(policy.dragAllowed(null,'files','start',true,true,'se')).toBe(true);
    expect(policy.dragAllowed(null,'$main','start',true,true)).toBe(true);
  });
  it('resizes each edge from the starting bounds while preserving opposite edges at the minimum', () => {
    const b={x:100,y:200,width:300,height:200}, start={x:0,y:0}, cursor={x:30,y:40};
    const expected={n:{x:100,y:240,width:300,height:160},s:{x:100,y:200,width:300,height:240},e:{x:100,y:200,width:330,height:200},w:{x:130,y:200,width:270,height:200},ne:{x:100,y:240,width:330,height:160},nw:{x:130,y:240,width:270,height:160},se:{x:100,y:200,width:330,height:240},sw:{x:130,y:200,width:270,height:240}};
    for (const [edge, result] of Object.entries(expected)) expect(policy.resizeBounds(b,start,cursor,edge)).toEqual(result);
    expect(policy.resizeBounds(b,start,{x:1000,y:1000},'nw')).toEqual({x:180,y:260,width:220,height:140});
    expect(policy.resizeBounds(b,start,{x:-1000,y:-1000},'se')).toEqual({x:100,y:200,width:220,height:140});
    expect(policy.resizeBounds({x:0,y:0,width:800,height:600},start,{x:-1000,y:-1000},'se',640,420)).toEqual({x:0,y:0,width:640,height:420});
  });
  it('keeps the requested size across repeated drags despite OS rounding', () => {
    const target={width:352,height:107};
    let actual={x:10,y:20,...target};
    for(let i=0;i<50;i++) {
      const start=policy.withTargetSize(actual,target);
      const requested=policy.dragBounds(start,{x:0,y:0},{x:5,y:7});
      expect(requested).toEqual({x:10+5*(i+1),y:20+7*(i+1),...target});
      actual={...requested,width:requested.width+1,height:requested.height+1};
    }
  });
  it('anchors a restored maximized window under the cursor with clamped margins', () => {
    const max={x:0,y:0,width:1920,height:1080}, normal={width:1000,height:700};
    expect(policy.restoredPosition(max,normal,{x:960,y:20})).toEqual({x:460,y:0});
    expect(policy.restoredPosition(max,normal,{x:0,y:70})).toEqual({x:-100,y:38});
    expect(policy.restoredPosition(max,normal,{x:1920,y:-5})).toEqual({x:1020,y:-5});
  });
  it('places the toolbar at the main window bottom center and clamps it to the work area', () => {
    const area={x:0,y:0,width:1920,height:1040};
    expect(policy.toolbarPosition({x:100,y:100,width:1280,height:800},area)).toEqual({x:564,y:772});
    expect(policy.toolbarPosition({x:-500,y:900,width:640,height:420},area)).toEqual({x:0,y:936});
    expect(policy.toolbarPosition({x:100,y:100,width:1280,height:800},area,{x:815,y:223})).toEqual({x:815,y:223});
    expect(policy.toolbarPosition({x:100,y:100,width:1280,height:800},area,{x:-172,y:1502})).toEqual({x:0,y:936});
  });
  it('accepts only bounded dock feedback and copies its display fields', () => {
    const rect={x:1,y:-2,width:30,height:40};
    expect(policy.dockFeedback({guides:[{key:'left',label:'左',button:rect}],ready:{preview:rect},rail:{edge:'left',rect}})).toEqual({guides:[{key:'left',label:'左',button:rect}],ready:{preview:rect},rail:{edge:'left',rect}});
    expect(policy.dockFeedback(null)).toBeNull();
    for (const value of [{guides:Array(17).fill({})},{guides:[{key:'x',label:'a'.repeat(33),button:rect}]},{guides:[],ready:{preview:{...rect,x:Infinity}}},{guides:[],rail:{edge:'top',rect}},{guides:[],ready:{preview:{...rect,width:-1}}}]) expect(()=>policy.dockFeedback(value)).toThrow();
  });
  it('transports validated customizable docking colors and excludes arbitrary CSS',()=>{
    expect(policy.dockFeedback({guides:[],ready:null,colors:{guideIcon:'#ABCDEF',previewBackground:'#12345677',arbitrary:'url(x)'}}).colors).toEqual({guideIcon:'#abcdef',previewBackground:'#12345677'});
    for(const colors of [{guideBackground:'url(x)'},{guideIcon:'#abcdef55'},{railBackground:'red'},[]])expect(()=>policy.dockFeedback({guides:[],ready:null,colors})).toThrow();
  });
});
