import {describe,it,expect} from 'vitest';
import {defaultTheme,normalizeTheme,readTheme,readDefaultTheme,switchThemeBase,resetThemeBase,themeTokens} from './themePreferences';
import {editorColors,editorColorFields,editorTokens,normalizeEditorProfiles} from './editorAppearance';
import {applyThemeTokens} from './applyTheme';
import {applyUserProfile,createTemplateBinding,templateBaseDefaults,userProfileFor} from './templateBinding';
import blue from '../../../templates/claude-mediterranean-blue/colors.json';

describe('independent text editor colors',()=>{
  it('keeps old templates valid and derives editor defaults from their own base',()=>{
    const binding=createTemplateBinding({id:'claude-mediterranean-blue',name:'blue',bases:['black','white']},blue);
    for(const base of binding.bases){const theme=templateBaseDefaults(binding,base),s=themeTokens(theme).surfaces,c=editorColors(theme);expect(c.selectionBackground).toBe(theme.colors.accent+'2a');expect(c.selectionBorder).toBe(theme.colors.accent+'b3');expect(c.selectionText).toBe(s.documentText);expect(c.annotationUnderline).toBe(theme.colors.accent);}
  });
  it('validates alpha backgrounds separately from text and rejects unknown or injected fields',()=>{
    expect(normalizeEditorProfiles({black:{selectionBackground:'#ABCDEF66',selectionText:'#12345699',cursor:'#ABCDEF',searchMatchBackground:'url(x)',unknown:'#123456'},white:[]})).toEqual({black:{selectionBackground:'#abcdef66',cursor:'#abcdef'}});
  });
  it('persists edits without changing interface selection and scopes them to each base',()=>{
    const theme=normalizeTheme({...defaultTheme,editorProfiles:{black:{selectionBackground:'#aa337788',selectionBorder:'#996633',selectionText:'#ffffff',textHighlightBackground:'#ab773399'},white:{selectionBackground:'#44556677',textHighlightBackground:'#ffe18866'}}});
    expect(readTheme(JSON.stringify(theme))).toEqual(theme);expect(readDefaultTheme(JSON.stringify({defaultScheme:theme}))).toEqual(theme);
    expect(themeTokens(theme).surfaces.selection).toBe(themeTokens(defaultTheme).surfaces.selection);
    expect(editorColors(theme).selectionBorder).toBe('#996633');
    expect(editorColors(switchThemeBase(theme,'white')).selectionBorder).toBe(editorColors(switchThemeBase(defaultTheme,'white')).selectionBorder);
    expect(editorColors(switchThemeBase(theme,'white')).selectionBackground).toBe('#44556677');expect(editorColors(switchThemeBase(switchThemeBase(theme,'white'),'black')).selectionBackground).toBe('#aa337788');
    const reloaded=readTheme(JSON.stringify(theme));
    expect(editorColors(reloaded).textHighlightBackground).toBe('#ab773399');
    expect(editorColors(switchThemeBase(reloaded,'white')).textHighlightBackground).toBe('#ffe18866');
    const reset=resetThemeBase(theme);expect(reset.editorProfiles.black).toBeUndefined();expect(reset.editorProfiles.white).toEqual(theme.editorProfiles.white);
  });
  it('freezes personal defaults while inheriting later template fields for current preferences',()=>{
    const identity={id:'claude-mediterranean-blue',name:'blue',bases:['black','white'] as ('black'|'white')[]},binding=createTemplateBinding(identity,blue),saved=templateBaseDefaults(binding,'black'),profile=userProfileFor(binding,saved,saved);
    const changed=createTemplateBinding(identity,{...blue,editorProfiles:{black:{selectionBackground:'#12345688'}}}),result=applyUserProfile(changed,profile);
    expect(editorColors(result.preferences).selectionBackground).toBe('#12345688');expect(editorColors(result.defaultScheme).selectionBackground).toBe(editorColors(saved).selectionBackground);expect(result.defaultScheme.editorProfiles).toEqual({});
    const edited=normalizeTheme({...saved,editorProfiles:{black:{cursor:'#abcdef'}}}),restored=applyUserProfile(changed,userProfileFor(binding,edited,edited));expect(editorColors(restored.preferences).cursor).toBe('#abcdef');
  });
  it('applies all editor fields to semantic CSS variables',()=>{
    const profile=Object.fromEntries(Object.entries(editorColorFields).map(([key,field])=>[key,field.alpha?'#12345678':'#654321'])),theme=normalizeTheme({...defaultTheme,editorProfiles:{black:profile}}),values:Record<string,string>={};
    const root={style:{getPropertyValue:(key:string)=>values[key],setProperty:(key:string,value:string)=>{values[key]=value;}},classList:{toggle:()=>{}}} as unknown as HTMLElement;
    applyThemeTokens(root,theme);for(const [key,value] of Object.entries(editorTokens(theme)))expect(values[key]).toBe(value);expect(values['--hive-selection-bg']).toBe(themeTokens(defaultTheme).surfaces.selection);
  });
});
