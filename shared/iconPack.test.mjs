import {describe,expect,it} from 'vitest';
import approvedIconIds from '../scripts/approved-icon-ids.json' with {type:'json'};
import template from '../templates/icons.json' with {type:'json'};
import builtins from './icons.json' with {type:'json'};
import {dockIconPayload,normalizeIconOverrides,validateIconDefinition,validateIconPack} from './iconPack.mjs';

const icon=(tag,attrs)=>({viewBox:'0 0 24 24',shapes:[{tag,attrs}]});

describe('template icons',()=>{
  it('ships a valid default pack with every registered key and approved asset',()=>{
    expect(Object.keys(validateIconPack(template).icons).sort()).toEqual(Object.keys(builtins).sort());
    expect(approvedIconIds.every(id=>Object.hasOwn(template.icons,id))).toBe(true);
    expect(template.icons.AiLauncher.viewBox).toBe('0 0 32 32');
    expect(template.icons['model.reasoning.serviceDefault'].shapes[1].attrs.fill).toBe('var(--icon-accent,currentColor)');
  });

  it('preserves only the two theme paints and keeps legacy paints monochrome',()=>{
    const value=validateIconDefinition(icon('path',{d:'M3 2A4 4 0 0110 11',fill:'rgb(127, 18, 8)',stroke:'var( --icon-danger , currentColor )'}));
    expect(value.shapes[0].attrs).toMatchObject({fill:'currentColor',stroke:'var(--icon-danger,currentColor)'});
    for(const paint of ['url(https://example.com/shape)', 'var(--icon-accent,url(https://example.com/shape))', 'var(--unknown,currentColor)']){
      expect(()=>validateIconDefinition(icon('path',{d:'M1 2L3 4',fill:paint}))).toThrow();
    }
  });

  it('rejects unsafe tags, inherited or unknown keys, and malformed geometry',()=>{
    for(const value of [icon('image',{href:'https://example.com/shape'}),icon('path',{d:'M1 2L3 4',onload:'code'}),icon('path',{d:'M 2'}),icon('path',{d:'M1 2L3'}),icon('polygon',{points:'1 2 3'})]){
      expect(()=>validateIconDefinition(value)).toThrow();
    }
    expect(()=>validateIconPack({version:1,icons:JSON.parse('{"__proto__":{}}')})).toThrow();
  });

  it('isolates bad overrides and only projects the five dock glyphs',()=>{
    const custom=icon('circle',{cx:'12',cy:'12',r:'5',fill:'var(--icon-accent,currentColor)'});
    const raw={ArrowLeft:custom,ArrowRight:icon('script',{}),'file.text':custom,unregistered:custom};
    expect(normalizeIconOverrides(raw)).toEqual({ArrowLeft:custom,'file.text':custom});
    const dock=dockIconPayload(raw);
    expect(Object.keys(dock)).toEqual(['left','right','top','bottom','center']);
    expect(dock.left.shapes).toEqual(custom.shapes);
    expect(dock.right.shapes).toEqual(builtins.ArrowRight.shapes);
  });
});
