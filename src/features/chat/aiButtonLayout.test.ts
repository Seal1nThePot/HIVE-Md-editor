import {describe,expect,it} from 'vitest';
import {normalizeAIButtonLayout,placeAIButton} from './aiButtonLayout';

describe('AI action positions',()=>{
  it('keeps each supported action once and restores missing or obsolete entries',()=>{
    expect(normalizeAIButtonLayout({left:['references','obsolete','references'],bottom:['sessions','references']})).toEqual({left:['references'],right:[],bottom:['sessions','history']});
  });
  it('moves between regions and reorders inside a region using the actual insertion gap',()=>{
    const original=normalizeAIButtonLayout(null);
    const together=placeAIButton(original,'history','left',0);
    expect(together).toEqual({left:['history','sessions'],right:['references'],bottom:[]});
    expect(placeAIButton(together,'history','left',2).left).toEqual(['sessions','history']);
    expect(placeAIButton(together,'sessions','left',2)).toEqual(together);
    expect(original.bottom).toEqual(['history']);
  });
});
