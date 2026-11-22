import {describe,expect,it} from 'vitest';
import {recentRepositoryOrder} from './recentRepositories';

const repositories=['a','b','c','d','e','f'].map(id=>({id,root:'/'+id,name:id.toUpperCase()}));

describe('recent repositories',()=>{
  it('uses the authoritative active id and filters removed and duplicate historical identities',()=>{
    expect(recentRepositoryOrder(['missing','b','a','c','b','d','e','f'],{id:'c',repositories})).toEqual(['c','b','a','d','e','f']);
  });
  it('does not add registered but unopened repositories',()=>{
    expect(recentRepositoryOrder({invalid:true},{id:'e',repositories})).toEqual(['e']);
    expect(recentRepositoryOrder(['a'],{id:'removed',repositories})).toEqual(['a']);
  });
});
