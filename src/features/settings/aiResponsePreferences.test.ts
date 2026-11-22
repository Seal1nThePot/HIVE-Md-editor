import {describe,expect,it} from 'vitest';
import {applyAIResponsePreferences,readAIResponsePreferences} from './useAIResponsePreferences';

describe('AI response preferences',()=>{
  it('preserves valid custom text when other saved fields are invalid',()=>{
    const input=JSON.stringify({detail:'unknown',tone:'formal',customRules:'第一条\r\n第二条',persona:2});
    expect(readAIResponsePreferences(input)).toEqual({version:1,detail:'concise',tone:'formal',customRules:'第一条\n第二条',persona:''});
    expect(readAIResponsePreferences('{')).toMatchObject({detail:'concise',tone:'natural'});
    const overlong='\0'.repeat(20_000);
    const capped=readAIResponsePreferences(JSON.stringify({customRules:overlong,persona:overlong}));
    expect(new TextEncoder().encode(JSON.stringify(capped)).length).toBeLessThan(131_072);
  });
  it('adds the chosen guidance to the original system content and preserves user text and history',()=>{
    const original=[{role:'system',content:'保持原格式。\n'},{role:'assistant',content:'历史回复'},{role:'user',content:'原问题及文档\n  '}];
    const defaults=applyAIResponsePreferences(original);
    expect(defaults[0].content).toContain('简洁，直接回答问题');
    expect(defaults[0].content).toContain('自然、平实');
    const detailed=applyAIResponsePreferences(original,{version:1,detail:'detailed',tone:'friendly',customRules:'每段加例子',persona:'编辑搭档'});
    expect(detailed[0].content.startsWith(original[0].content)).toBe(true);
    expect(detailed[0].content).toContain('回复详细度：详细');
    expect(detailed[0].content).toContain('回复语气：亲切');
    expect(detailed[0].content).toContain('自定义规则：每段加例子');
    expect(detailed[0].content).toContain('人设：编辑搭档');
    expect(detailed.slice(1)).toEqual(original.slice(1));
  });
});
