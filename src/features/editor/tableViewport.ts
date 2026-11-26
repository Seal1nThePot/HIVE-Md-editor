import type {Text} from '@codemirror/state';
import type {PreviewCell,PreviewReplacement} from './markdownPresentation';

export const tableWidgetCellBudget=256,tableWidgetRowBudget=32;
export type TableSegment={from:number;to:number;fromRow:number;toRow:number};
const segments=new WeakMap<PreviewReplacement,TableSegment[]>();

/** Each replacement is independently virtualized by CodeMirror's ordinary viewport. */
export function tableSegments(item:PreviewReplacement,doc:Text):TableSegment[]{
  const cached=segments.get(item);if(cached)return cached;
  const rows=item.rows||[],columns=item.columns??rows[0]?.length??0,result:TableSegment[]=[];
  if(columns>tableWidgetCellBudget)return result; // A very wide table remains editable source.
  const step=Math.max(1,Math.min(tableWidgetRowBudget,Math.floor(tableWidgetCellBudget/Math.max(1,columns))));
  for(let fromRow=0;fromRow<rows.length;fromRow+=step){
    const toRow=Math.min(rows.length,fromRow+step);
    const start=(row:number)=>doc.lineAt(rows[row][0]?.from??item.rowEnds?.[row]?.to??item.to).from;
    // A source newline must remain between block replacements. Hiding it would join
    // every segment into one CodeMirror line block and mount the entire table again.
    result.push({from:fromRow?start(fromRow):item.from,to:toRow<rows.length?start(toRow)-1:item.to,fromRow,toRow});
  }
  segments.set(item,result);return result;
}

export function tableCell(item:PreviewReplacement,row:number,col:number):PreviewCell|undefined{
  const cells=item.rows?.[row];if(!cells)return undefined;
  if(cells[col])return cells[col];
  const end=item.rowEnds?.[row];
  return end&&col<(item.columns??0)?{from:end.to,to:end.to,text:'',virtual:col,trailing:end.trailing}:undefined;
}

const columnWidths=new WeakMap<PreviewReplacement,number[]>();
const defaultColumnWidth=6,bodyWidthLimit=20,headerWidthLimit=12,outlierWidthLimit=8;
const widthAllowance=2,maxSampleRows=32,wideCharacter=/[\u2E80-\u9FFF\uAC00-\uD7AF\uFF01-\uFF60]/u;

function approximateLength(text:string,limit:number){
  let length=0;
  for(const character of text){
    length+=wideCharacter.test(character)?1:.58;
    if(length>=limit)return limit;
  }
  return length;
}

/** Use the same font-relative widths in every mounted segment of a source table. */
export function defaultTableWidths(item:PreviewReplacement){
  const existing=columnWidths.get(item);if(existing)return existing;
  const rows=item.rows??[],header=rows[0]??[];
  const lengths=Array.from({length:item.columns??header.length},()=>[] as number[]);
  const bodyRows=Math.max(0,rows.length-1),sampleCount=Math.min(bodyRows,maxSampleRows);
  for(let index=0;index<sampleCount;index++){
    const row=rows[1+Math.floor(index*(bodyRows-1)/Math.max(1,sampleCount-1))];
    row.forEach((cell,col)=>{
      if(cell.text)lengths[col]?.push(approximateLength(cell.text,bodyWidthLimit-widthAllowance));
    });
  }
  const widths=lengths.map((values,col)=>{
    values.sort((a,b)=>a-b);
    // The lower-ranked 75th percentile leaves a lone outlier out of a short sample.
    const typical=values[Math.floor((values.length-1)*.75)]??0;
    const label=approximateLength(header[col]?.text??'',headerWidthLimit-widthAllowance);
    const longest=values.at(-1)??0;
    // Let an exceptional value use several lines, with a bounded allowance for compact columns.
    const outlier=Math.min(outlierWidthLimit,longest/3+widthAllowance);
    return Math.ceil(Math.max(defaultColumnWidth,typical+widthAllowance,label+widthAllowance,outlier));
  });
  columnWidths.set(item,widths);return widths;
}

/** DOM identity follows the source table, including independently mounted row segments. */
export function sameSourceTable(a:Element|null|undefined,b:Element|null|undefined){
  if(!a||!b)return false;
  if(a===b)return true;
  const first=(a as HTMLElement).dataset.tableOrdinal,second=(b as HTMLElement).dataset.tableOrdinal;
  return first!==undefined&&first===second&&a.closest('.cm-editor')===b.closest('.cm-editor');
}

/** Keep manual sizes, fit automatic columns to the page, then overflow at readable minima. */
export function fitTableWidths(weights:number[],manual:(number|null)[],available:number,fontSize:number){
  const minimum=weights.map(weight=>(weight<=8?4:6)*fontSize);
  const result=weights.map((_,index)=>typeof manual[index]==='number'?manual[index]!:minimum[index]);
  const automatic=weights.map((_,index)=>index).filter(index=>typeof manual[index]!=='number');
  let remaining=Math.max(0,available-result.reduce((sum,width)=>sum+width,0));
  const weightSum=automatic.reduce((sum,index)=>sum+weights[index],0);
  for(const index of automatic)result[index]+=remaining*(weights[index]/Math.max(1,weightSum));
  return result;
}
