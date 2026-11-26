import {useEffect,useState} from 'react';
import SettingRow from '../settings/SettingRow';
import {rangeProgressStyle} from '../settings/rangeProgress';
import {applyTypographyPreset,isTypographyCustomized,typographyLimits,typographyPresets,type TypographyPreset} from './typographyPreferences';
import {useTypography} from './typographyStore';
import './typography-settings.css';

export default function TypographySettings(){
  const {preferences,setTypography,saveError}=useTypography();
  const [draft,setDraft]=useState({maxWidth:String(preferences.maxWidth),lineHeight:String(preferences.lineHeight),paragraphSpacing:String(preferences.paragraphSpacing)});
  useEffect(()=>setDraft({maxWidth:String(preferences.maxWidth),lineHeight:String(preferences.lineHeight),paragraphSpacing:String(preferences.paragraphSpacing)}),[preferences]);
  const controls=[
    {key:'maxWidth' as const,label:'正文最大宽度',unit:'px',description:'版心总宽度（含两侧留白）；较窄的分屏或窗口会自动收缩。'},
    {key:'lineHeight' as const,label:'行高',unit:'倍',description:'同一段内相邻文字行的高度，相对于正文与草稿字号。'},
    {key:'paragraphSpacing' as const,label:'段间距',unit:'em',description:'每个语义段落末尾的额外留白；1 em 等于一个正文字号。原文空行仍保留，软折行不重复增加。'},
  ];
  return <fieldset className="typography-settings"><legend>正文与草稿排版</legend><p>只调整本机显示，保留 Markdown 原文。正文与草稿共用设置。段间距与首行缩进作用于实时预览和实时编辑。</p>
    <SettingRow title={<label htmlFor="typography-preset">显示风格</label>} description={typographyPresets[preferences.preset].description}>
      <select id="typography-preset" value={preferences.preset} onChange={event=>setTypography(applyTypographyPreset(event.target.value as TypographyPreset,preferences.tableDensity))}>{Object.entries(typographyPresets).map(([key,preset])=><option key={key} value={key}>{preset.label}</option>)}</select>
      <button type="button" onClick={()=>setTypography(applyTypographyPreset(preferences.preset,preferences.tableDensity))}>恢复此预设</button>
    </SettingRow>
    {isTypographyCustomized(preferences)&&<p className="typography-customized" role="status">已自定义「{typographyPresets[preferences.preset].label}」参数</p>}
    {controls.map(({key,label,unit,description})=>{
      const {min,max,step}=typographyLimits[key];
      return <SettingRow key={key} title={<label htmlFor={`typography-${key}`}>{label}</label>} description={description}>
        <input id={`typography-${key}`} type="range" min={min} max={max} step={step} value={preferences[key]} style={rangeProgressStyle(preferences[key],min,max)} onChange={event=>setTypography(old=>({...old,[key]:Number(event.target.value)}))}/>
        <input type="number" aria-label={`${label}数值`} min={min} max={max} step={step} value={draft[key]} onChange={event=>{
          const text=event.target.value,value=Number(text);setDraft(old=>({...old,[key]:text}));if(text&&Number.isFinite(value)&&value>=min&&value<=max)setTypography(old=>({...old,[key]:value}));
        }} onBlur={()=>{const value=Number(draft[key]),next=draft[key]&&Number.isFinite(value)?Math.max(min,Math.min(max,value)):preferences[key];setDraft(old=>({...old,[key]:String(next)}));setTypography(old=>({...old,[key]:next}));}} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();event.currentTarget.blur();}}}/><span>{unit}</span>
      </SettingRow>;
    })}
    <SettingRow title="普通段落首行缩进" description="首行缩进两个汉字宽；标题、代码、表格、列表、引用和独立公式保持各自的结构。"><input className="setting-switch" aria-label="普通段落首行缩进" type="checkbox" checked={preferences.firstLineIndent} onChange={event=>setTypography(old=>({...old,firstLineIndent:event.target.checked}))}/></SettingRow>
    <SettingRow title={<label htmlFor="typography-table-density">表格排版</label>} description="独立调整所有正文表格的行高与单元格留白，正文预设保持此设置。"><select id="typography-table-density" value={preferences.tableDensity} onChange={event=>setTypography(old=>({...old,tableDensity:event.target.value==='standard'?'standard':'compact'}))}><option value="compact">紧凑</option><option value="standard">标准</option></select></SettingRow>
    {saveError&&<p role="status">{saveError}</p>}
  </fieldset>;
}
