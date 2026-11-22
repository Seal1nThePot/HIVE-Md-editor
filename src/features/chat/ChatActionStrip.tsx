import {Icon} from '../../shared/icons';
import {aiButtons,aiRegionLabels,type AIButtonId,type AIButtonRegion} from './aiButtonLayout';
import './chat-action-strip.css';

export function ChatActionStrip({items,region,sessionsOpen,sessionLabel,onAction}:{
  items:readonly AIButtonId[];
  region:AIButtonRegion;
  sessionsOpen:boolean;
  sessionLabel:string;
  onAction:(id:AIButtonId)=>void;
}){
  if(!items.length)return null;
  return <div className="chat-action-strip" data-chat-action-region={region} role="group" aria-label={aiRegionLabels[region]+' AI 功能'}>
    {items.map(id=>{
      const {icon,label}=aiButtons[id];
      return <button type="button" key={id} data-chat-action={id} aria-label={label}
        aria-expanded={id==='sessions'?sessionsOpen:undefined}
        title={id==='sessions'?label+' · '+sessionLabel:label} onClick={()=>onAction(id)}>
        <Icon name={icon} size={16}/>
      </button>;
    })}
  </div>;
}
