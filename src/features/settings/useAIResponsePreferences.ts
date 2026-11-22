import {useEffect,useState} from 'react';

export type AIResponseDetail='concise'|'detailed';
export type AIResponseTone='natural'|'formal'|'friendly';
export type AIResponsePreferences={version:1;detail:AIResponseDetail;tone:AIResponseTone;customRules:string;persona:string};
export const aiResponsePreferencesKey='hive.aiResponsePreferences.v1';
// Keep two backslash-escaped text fields inside the desktop preference record limit.
export const aiResponseTextLimit=8000;
const defaults:AIResponsePreferences={version:1,detail:'concise',tone:'natural',customRules:'',persona:''};

export function normalizeAIResponsePreferences(value:unknown):AIResponsePreferences{
  if(!value||typeof value!=='object'||Array.isArray(value))return defaults;
  const {detail,tone,customRules,persona}=value as Record<string,unknown>;
  return {version:1,
    detail:detail==='detailed'?detail:'concise',
    tone:tone==='formal'||tone==='friendly'?tone:'natural',
    customRules:typeof customRules==='string'?customRules.replace(/\r\n?/g,'\n').slice(0,aiResponseTextLimit):'',
    persona:typeof persona==='string'?persona.replace(/\r\n?/g,'\n').slice(0,aiResponseTextLimit):'',
  };
}

export function readAIResponsePreferences(raw:string|null):AIResponsePreferences{
  try{return normalizeAIResponsePreferences(JSON.parse(raw??'null'));}
  catch{return defaults;}
}

export function useAIResponsePreferences(){
  const [preferences,setPreferences]=useState<AIResponsePreferences>(()=>{
    try{return readAIResponsePreferences(localStorage.getItem(aiResponsePreferencesKey));}
    catch{return defaults;}
  });
  const [saveError,setSaveError]=useState('');
  useEffect(()=>{
    try{localStorage.setItem(aiResponsePreferencesKey,JSON.stringify(preferences));setSaveError('');}
    catch{setSaveError('AI 回复偏好暂时无法保存，本次选择仍然生效。');}
  },[preferences]);
  return {preferences,setPreferences,saveError};
}

const detailGuidance:Record<AIResponseDetail,string>={
  concise:'简洁，直接回答问题。用户明确要求分析或教程时，按要求展开。',
  detailed:'详细，根据本轮要求提供必要的细节、依据或步骤，避免重复。',
};
const toneGuidance:Record<AIResponseTone,string>={natural:'自然、平实。',formal:'正式、用词严谨。',friendly:'亲切、温和。'};

export function applyAIResponsePreferences(messages:readonly {role:string;content:string}[],preferences?:AIResponsePreferences){
  const prefs=normalizeAIResponsePreferences(preferences);
  const guidance=[
    '【回复偏好】',
    `回复详细度：${detailGuidance[prefs.detail]}`,
    `回复语气：${toneGuidance[prefs.tone]}`,
    ...(prefs.customRules.trim()?[`自定义规则：${prefs.customRules.trim()}`]:[]),
    ...(prefs.persona.trim()?[`人设：${prefs.persona.trim()}`]:[]),
    '在遵守本轮任务、当前写作模式、输出格式和长度限制的前提下应用这些偏好。',
  ].join('\n');
  const index=messages.findIndex(message=>message.role==='system');
  if(index<0)return [{role:'system',content:guidance},...messages];
  return messages.map((message,i)=>i===index?{...message,content:message.content+'\n\n'+guidance}:message);
}
