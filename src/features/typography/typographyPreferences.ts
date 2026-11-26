export const typographyStorageKey='hive.typography.v1';
export type TypographyPreset='original'|'novel'|'brief'|'article';
export type TypographyPreferences={version:1;preset:TypographyPreset;maxWidth:number;lineHeight:number;paragraphSpacing:number;firstLineIndent:boolean;tableDensity:'compact'|'standard'};
type Preset={label:string;description:string;maxWidth:number;lineHeight:number;paragraphSpacing:number;firstLineIndent:boolean};
export const typographyPresets:Record<TypographyPreset,Preset>={
  original:{label:'原有显示',description:'保留原有版心与行距，不额外增加段尾留白。',maxWidth:780,lineHeight:2.05,paragraphSpacing:0,firstLineIndent:false},
  novel:{label:'小说',description:'稍窄版心、舒展行距，普通段落首行缩进两字。',maxWidth:760,lineHeight:2.05,paragraphSpacing:.35,firstLineIndent:true},
  brief:{label:'简报',description:'较宽版心、紧凑行距，用段尾留白区分信息。',maxWidth:900,lineHeight:1.65,paragraphSpacing:.65,firstLineIndent:false},
  article:{label:'文章',description:'适中的版心、行距与段尾留白，适合长文阅读。',maxWidth:820,lineHeight:1.9,paragraphSpacing:.6,firstLineIndent:false},
};
export const typographyLimits={maxWidth:{min:320,max:1600,step:10},lineHeight:{min:1.2,max:3,step:.05},paragraphSpacing:{min:0,max:2,step:.05}} as const;
export function applyTypographyPreset(preset:TypographyPreset,tableDensity:TypographyPreferences['tableDensity']='compact'):TypographyPreferences{
  const {maxWidth,lineHeight,paragraphSpacing,firstLineIndent}=typographyPresets[preset];
  return {version:1,preset,maxWidth,lineHeight,paragraphSpacing,firstLineIndent,tableDensity};
}
export const defaultTypography=applyTypographyPreset('original');
const bounded=(value:unknown,fallback:number,min:number,max:number)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;
export function normalizeTypography(input:unknown):TypographyPreferences{
  if(!input||typeof input!=='object'||(input as {version?:unknown}).version!==1)return {...defaultTypography};
  const saved=input as Record<string,unknown>,preset=typeof saved.preset==='string'&&Object.hasOwn(typographyPresets,saved.preset)?saved.preset as TypographyPreset:'original',base=applyTypographyPreset(preset);
  return {version:1,preset,tableDensity:saved.tableDensity==='standard'?'standard':'compact',maxWidth:bounded(saved.maxWidth,base.maxWidth,320,1600),lineHeight:bounded(saved.lineHeight,base.lineHeight,1.2,3),paragraphSpacing:bounded(saved.paragraphSpacing,base.paragraphSpacing,0,2),firstLineIndent:typeof saved.firstLineIndent==='boolean'?saved.firstLineIndent:base.firstLineIndent};
}
export function isTypographyCustomized(value:TypographyPreferences){
  const base=typographyPresets[value.preset];
  return value.maxWidth!==base.maxWidth||value.lineHeight!==base.lineHeight||value.paragraphSpacing!==base.paragraphSpacing||value.firstLineIndent!==base.firstLineIndent;
}
