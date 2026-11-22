import {useEffect,useState} from 'react';
import type {IconName} from '../../shared/icons';

export const aiButtonRegions=['left','right','bottom'] as const;
export type AIButtonRegion=typeof aiButtonRegions[number];
export const aiRegionLabels:Record<AIButtonRegion,string>={left:'左侧',right:'右侧',bottom:'底部'};
export const aiButtons={
  sessions:{label:'会话管理',icon:'MessageSquare'},
  references:{label:'参考资料管理',icon:'conversation.viewBasis'},
  history:{label:'AI 操作历史记录',icon:'history.tab.ai'},
} as const satisfies Record<string,{label:string;icon:IconName}>;
export type AIButtonId=keyof typeof aiButtons;
export type AIButtonLayout=Record<AIButtonRegion,AIButtonId[]>;
const layoutKey='hive.aiButtonLayout.v1';
const defaultLayout:AIButtonLayout={left:['sessions'],right:['references'],bottom:['history']};

export function normalizeAIButtonLayout(raw:unknown):AIButtonLayout {
  const saved=(raw??{}) as Partial<Record<AIButtonRegion,unknown>>;
  const seen=new Set<AIButtonId>();
  const result:AIButtonLayout={left:[],right:[],bottom:[]};
  for(const region of aiButtonRegions){
    const items=saved[region];
    if(!Array.isArray(items))continue;
    for(const item of items){
      if(typeof item!=='string'||!Object.hasOwn(aiButtons,item)||seen.has(item as AIButtonId))continue;
      seen.add(item as AIButtonId);
      result[region].push(item as AIButtonId);
    }
  }
  for(const region of aiButtonRegions)result[region].push(...defaultLayout[region].filter(id=>!seen.has(id)));
  return result;
}

export function placeAIButton(layout:AIButtonLayout,id:AIButtonId,region:AIButtonRegion,gap:number):AIButtonLayout {
  const oldIndex=layout[region].indexOf(id);
  const result={left:layout.left.filter(item=>item!==id),right:layout.right.filter(item=>item!==id),bottom:layout.bottom.filter(item=>item!==id)};
  const index=gap-(oldIndex>=0&&gap>oldIndex?1:0);
  result[region].splice(Math.max(0,Math.min(index,result[region].length)),0,id);
  return result;
}

export function useAIButtonLayout(){
  const [layout,setLayout]=useState<AIButtonLayout>(()=>{
    try{return normalizeAIButtonLayout(JSON.parse(localStorage.getItem(layoutKey)??'null'));}
    catch{return normalizeAIButtonLayout(null);}
  });
  const [saveError,setSaveError]=useState('');
  useEffect(()=>{
    try{localStorage.setItem(layoutKey,JSON.stringify(layout));setSaveError('');}
    catch{setSaveError('AI 按钮位置暂时无法保存，本次调整仍然生效。');}
  },[layout]);
  return {layout,setLayout,saveError};
}
