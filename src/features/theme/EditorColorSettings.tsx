import ThemeColorField from './ThemeColorField';
import {editorColors,editorColorFields,type EditorColorRole} from './editorAppearance';
import {themeTokens,type ThemePreferences} from './themePreferences';

export default function EditorColorSettings({preferences,onChange}:{preferences:ThemePreferences;onChange:(next:(old:ThemePreferences)=>ThemePreferences)=>void}){
  const surfaces=themeTokens(preferences).surfaces,colors=editorColors(preferences);
  return <section className="theme-detail-section editor-color-settings" aria-labelledby="editor-colors-title"><h2 id="editor-colors-title">文本编辑页面</h2><p>选区线框和底色可独立调整，颜色与不透明度随当前方案保存。</p>
    <div className="theme-detail-grid">{([['document','页面背景'],['documentText','正文文字']] as const).map(([key,label])=><div key={key}><span>{label}</span><ThemeColorField label={label} value={surfaces[key]} onChange={value=>onChange(old=>({...old,surfaceColors:{...old.surfaceColors,[old.base]:{...old.surfaceColors[old.base],[key]:value}}}))}/></div>)}
    {(Object.keys(editorColorFields) as EditorColorRole[]).map(key=>{const field=editorColorFields[key];return <div key={key}><span>{field.label}</span><ThemeColorField label={field.label} value={colors[key]} alpha={field.alpha} onChange={value=>onChange(old=>({...old,editorProfiles:{...old.editorProfiles,[old.base]:{...old.editorProfiles[old.base],[key]:value}}}))}/></div>;})}</div>
  </section>;
}
