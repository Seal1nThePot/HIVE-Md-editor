import {AiLauncher,Icon,ListTree,PencilLine,WandSparkles} from "../../shared/icons";
import {modeLabels,type Mode} from '../../shared/core';
import './writing-dock.css';
import {DockTooltip} from './DockTooltip';

export default function WritingDock({mode,continuationLimit,aiOpen,annotationTool,annotationHint,busy,onRun,onToggleAi,onAnnotate}:{mode:Mode;continuationLimit:number;aiOpen:boolean;annotationTool:boolean;annotationHint?:string;busy?:boolean;onRun:(mode:Mode)=>void;onToggleAi:()=>void;onAnnotate:()=>void}){
  const modes=[{mode:'outline',Icon:ListTree},{mode:'edit',Icon:WandSparkles},{mode:'continue',Icon:PencilLine}] as const;
  function modeButton({mode:value,Icon}:typeof modes[number]){
    const hint=value==='continue'?`${modeLabels[value]} · 最多 ${continuationLimit} 字 · 点一下立即执行`:`${modeLabels[value]} · 点一下立即执行`;
    return <button key={value} type="button" className={'dock-mode-button '+(mode===value?'active':'')} aria-label={modeLabels[value]} aria-pressed={mode===value}
      data-tooltip={busy?'正在生成，请稍候':hint} disabled={busy} onClick={()=>onRun(value)}><Icon size={19}/></button>;
  }
  return <footer className="bottom-bar floating-mode-dock writing-dock" aria-label="写作快捷栏"><DockTooltip><div className="writing-dock-controls">
    <button type="button" className={'dock-mode-button dock-annotation-button'+(annotationTool?' active':'')} aria-label="标注工具" aria-pressed={annotationTool} data-tooltip={annotationHint??(annotationTool?'标注工具已开启 · 拖选文字':'标注工具 · 点击后拖选文字')} onPointerDown={event=>event.preventDefault()} onClick={onAnnotate}><Icon name="annotation.markSelection" size={19}/></button>
    {modes.slice(0,1).map(modeButton)}
    <button type="button" className={'dock-ai-button'+(aiOpen?' active':'')+(busy?' ai-running':'')} aria-label={aiOpen?'显示 AI 面板':'打开 AI 面板'} aria-expanded={aiOpen} data-tooltip={aiOpen?'将 AI 面板提到前面':'打开 AI 面板'} onClick={onToggleAi}>
      <AiLauncher size={29}/>
    </button>
    {modes.slice(1).map(modeButton)}
  </div></DockTooltip></footer>;
}
