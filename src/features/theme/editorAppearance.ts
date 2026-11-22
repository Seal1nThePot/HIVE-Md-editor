import schema from '../../../desktop/editor-colors.json';
import {themeTokens,type BaseColor,type ThemePreferences} from './themePreferences';

export const editorColorFields=schema;
export type EditorColorRole=keyof typeof schema;
export type EditorColors=Record<EditorColorRole,string>;
export type EditorProfiles=Partial<Record<BaseColor,Partial<EditorColors>>>;
export const editorVariable=(key:EditorColorRole)=>'--hive-editor-'+key.replace(/[A-Z]/g,value=>'-'+value.toLowerCase());

export function normalizeEditorProfiles(value:unknown):EditorProfiles{
  const result:EditorProfiles={};if(!value||typeof value!=='object'||Array.isArray(value))return result;
  for(const base of ['black','gray','white','custom'] as const){
    const raw=(value as Record<string,unknown>)[base];if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    const colors:Partial<EditorColors>={};
    for(const key of Object.keys(schema) as EditorColorRole[]){const color=(raw as Record<string,unknown>)[key];if(typeof color==='string'&&(schema[key].alpha?/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i:/^#[0-9a-f]{6}$/i).test(color))colors[key]=color.toLowerCase();}
    if(Object.keys(colors).length)result[base]=colors;
  }
  return result;
}
const cache=new WeakMap<ThemePreferences,EditorColors>();
/** Optional overrides keep old templates valid and inherit each template's own palette. */
export function editorColors(theme:ThemePreferences):EditorColors{
  const cached=cache.get(theme);if(cached)return cached;
  const s=themeTokens(theme).surfaces,accent=theme.colors.accent;
  const rgb=[1,3,5].map(i=>parseInt(s.document.slice(i,i+2),16));
  const linkText=(rgb[0]*0.299+rgb[1]*0.587+rgb[2]*0.114)>150?'#175cb8':'#8ab4ff';
  const colors:EditorColors={linkText,cursor:s.documentText,selectionBackground:accent+'2a',selectionBorder:accent+'b3',selectionText:s.documentText,textHighlightBackground:theme.colors.warning+'47',inactiveSelectionBackground:accent+'18',activeLineBackground:s.documentText+'18',selectionMatchBackground:accent+'30',searchMatchBackground:accent+'3b',searchCurrentBackground:accent+'70',annotationBackground:accent+'24',annotationUnderline:accent,tableSelectionBackground:accent+'30',tableSelectionBorder:accent,...theme.editorProfiles?.[theme.base]};
  cache.set(theme,colors);return colors;
}
export function editorTokens(theme:ThemePreferences){return Object.fromEntries((Object.entries(editorColors(theme)) as [EditorColorRole,string][]).map(([key,color])=>[editorVariable(key),color]));}
