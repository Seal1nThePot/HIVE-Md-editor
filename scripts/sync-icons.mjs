import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {validateIconDefinition} from '../shared/iconPack.mjs';

const templateFile=new URL('../templates/icons.json',import.meta.url);
const fallbackFile=new URL('../shared/icons.json',import.meta.url);
const approvedIdsFile=new URL('./approved-icon-ids.json',import.meta.url);
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
const [pack,fallback,approvedIconIds]=await Promise.all([templateFile,fallbackFile,approvedIdsFile].map(readJson));
const flag=process.argv[2]??'--check';
assert.ok(['--check','--write-fallback'].includes(flag),'Use --check or --write-fallback.');
assert.ok(pack?.version===1&&pack.icons&&typeof pack.icons==='object'&&!Array.isArray(pack.icons),'Expected a version 1 icon pack.');

const requiredNames=new Set([...Object.keys(fallback),...approvedIconIds]);
for(const name of requiredNames)assert.ok(Object.hasOwn(pack.icons,name),`Missing template icon ${name}.`);

function validate(name,icon){
  try{return validateIconDefinition({viewBox:'0 0 24 24',...icon});}
  catch(error){throw new Error(`Invalid icon ${name}: ${error.message}`,{cause:error});}
}
const entries=Object.entries(pack.icons).map(([name,icon])=>{
  assert.match(name,/^[A-Z][A-Za-z0-9]*$|^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/);
  assert.ok(icon&&typeof icon.viewBox==='string',`Missing viewBox for ${name}.`);
  return [name,validate(name,icon)];
});

if(flag==='--write-fallback'){
  const lines=entries.map(([name,icon])=>`  ${JSON.stringify(name)}: ${JSON.stringify(icon)}`);
  await writeFile(fallbackFile,`{\n${lines.join(',\n')}\n}\n`,'utf8');
}else{
  for(const [name] of entries){
    assert.ok(Object.hasOwn(fallback,name),`Missing fallback for ${name}.`);
    validate(name,fallback[name]);
  }
}
console.log(`${entries.length} template icons checked${flag==='--write-fallback'?' and exported to the fallback registry':''}.`);
