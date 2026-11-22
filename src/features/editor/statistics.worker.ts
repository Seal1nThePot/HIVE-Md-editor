import {textDocumentStatistics,textStatistics} from './statusModel';

self.onmessage=(event:MessageEvent<{id:number;texts:string[];document:boolean}>)=>{
  const {id,texts,document}=event.data;
  try{
    if(document){
      self.postMessage({id,value:textDocumentStatistics(texts[0])});
      return;
    }
    const value={characters:0,pureCount:0,paragraphs:0};
    for(const text of texts){const part=textStatistics(text);value.characters+=part.characters;value.pureCount+=part.pureCount;value.paragraphs+=part.paragraphs;}
    self.postMessage({id,value});
  }
  catch{self.postMessage({id,error:'字数统计暂时不可用'});}
};
