import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { annotationMessages } from "../src/features/annotations/annotations.ts";
import { probeModelService } from "./model-probe.mjs";
import { launchBackend } from "../desktop/backendProcess.mjs";
let mock,
  backend,
  temp,
  base,
  mockBase,
  reply = "valid",
  lastBody,
  lastAuthorization,
  lastPath,
  aborted = false,
  probeRequests = [],
  catalog = [],
  releaseCatalog;
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
async function post(route, body) {
  return fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "hive-integration-"));
  mock = createServer(async (req, res) => {
    const buffers = [];
    for await (const chunk of req) buffers.push(chunk);
    const payload = Buffer.concat(buffers).toString();
    lastBody = payload ? JSON.parse(payload) : null;
    lastAuthorization = req.headers.authorization;
    lastPath = req.url;
    if (reply === 'unsupported-output-limit' && lastBody?.max_completion_tokens) {
      res.writeHead(400,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:{param:'max_completion_tokens',code:'unsupported_parameter'}}));
    }
    if (req.method === 'GET' || lastBody?.stream === false) {
      probeRequests.push({path:req.url,method:req.method,authorization:req.headers.authorization,body:lastBody});
      if (reply === 'slow-catalog') return;
      if (reply === 'delayed-catalog') await new Promise(resolve => { releaseCatalog = resolve; });
      if (reply === 'redirect') {
        res.writeHead(307,{Location:'/v1/models'});
        return res.end();
      }
      if (reply === 'bad-catalog') return res.end('<html>private-upstream-detail</html>');
      if (reply === 'unsupported-limit' && lastBody?.max_completion_tokens) {
        res.writeHead(400,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({error:{param:'max_completion_tokens',code:'unsupported_parameter',message:'private-upstream-detail'}}));
      }
      if (reply !== 'http-error') {
        res.writeHead(200, {'Content-Type':'application/json'});
        return res.end(JSON.stringify(req.method === 'GET' ? {data:catalog} : {choices:[{message:{content:'OK'}}]}));
      }
    }
    if (reply === "http-error") {
      res.writeHead(401);
      return res.end("secret provider detail that should not appear");
    }
    if (reply === 'reject-effort' && lastBody?.reasoning_effort) {
      res.writeHead(400,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({error:{param:'reasoning_effort',code:'unsupported_value',message:'private provider rejection'}}));
    }
    if (reply === 'output-capped') {
      res.writeHead(200,{'Content-Type':'application/json'});
      return res.end(JSON.stringify({choices:[{message:{content:'截断的回复'},finish_reason:'length'}]}));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    if (reply === "slow") {
      res.on("close", () => {
        aborted = true;
      });
      return;
    }
    const text = JSON.stringify({
      text: "一段完整的短文。",
      reason: "符合本轮要求。",
    });
    const frame = JSON.stringify({ choices: [{ delta: { content: text } }] });
    // Deliberately split CRLF between writes to exercise incremental framing.
    res.write("data: " + frame + "\r");
    await new Promise((resolve) => setTimeout(resolve, 12));
    res.write("\n\r");
    await new Promise((resolve) => setTimeout(resolve, 12));
    res.write("\n");
    if (reply !== "truncated") res.write("data: [DONE]\r\n\r\n");
    res.end();
  });
  mockBase = `http://127.0.0.1:${await listen(mock)}/v1`;
  const project = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  backend = launchBackend({
    root: project,
    env: {
      HIVE_PORT: "0",
      HIVE_DOCUMENTS: path.join(temp, "documents"),
      HIVE_STATE_DIR: path.join(temp, "state"),
      HIVE_API_KEY: "",
    },
  });
  const { port } = await backend.ready;
  base = `http://127.0.0.1:${port}`;
}, 15000);
beforeEach(async () => {
  reply = "valid";
  aborted = false;
  probeRequests = [];
  catalog = [];
  releaseCatalog = undefined;
  const response = await post("/api/config", {
    endpoint: mockBase,
    model: "local-contract-stub",
    demo: false,
    continuationLimit: 100,
    key: "test-only-key",
  });
  expect(response.ok).toBe(true);
});
afterAll(async () => {
  await backend?.stop();
  if (mock) {
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
  if (
    temp &&
    path.dirname(temp) === os.tmpdir() &&
    path.basename(temp).startsWith("hive-integration-")
  )
    await fs.rm(temp, { recursive: true, force: true });
});
describe("HTTP model and local service contract", () => {
  it('resolves external Markdown snapshots without importing them into the document tree', async () => {
    const name = 'frontend-map.md';
    const body = Buffer.from('\ufeff附件内容\r\n下一行');
    const upload = (route, data = body) => fetch(base + route + '?name=' + name, {
      method: 'POST',
      headers: {'Content-Type': 'application/octet-stream'},
      body: data,
    });
    const documents = path.join(temp, 'documents');
    const before = await fs.readdir(documents);
    const saved = await upload('/api/references/attachments');
    expect(saved.status).toBe(200);
    const attachment = await saved.json();
    expect(attachment).toMatchObject({type:'attachment',path:name,id:expect.any(String)});
    expect(await fs.readdir(documents)).toEqual(before);

    const tree = await fetch(base + '/api/tree').then(response => response.json());
    expect(tree.entries).not.toEqual(expect.arrayContaining([expect.objectContaining({path:name})]));
    const invalid = await upload('/api/references/attachments', Buffer.from([0xff]));
    expect(invalid.status).toBe(400);
    expect((await upload('/api/references/attachments', Buffer.alloc(2_000_001))).status).toBe(413);

    const normalImport = await upload('/api/import', Buffer.from('仓库笔记'));
    expect(await normalImport.json()).toMatchObject({kind:'markdown',path:name});
    const sources = [attachment, {type:'file',path:name}];
    const resolved = await post('/api/references/resolve', {
      sources, budget: 10, overrides: [{path:name,text:'未保存正文',characters:5}],
    });
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).files).toEqual([
      {path:name,source:name,text:'附件内容\n下一行',characters:8,truncated:false},
      {path:name,source:name,text:'未保',characters:5,truncated:true,unsaved:true},
    ]);

    const removed = await fetch(base + '/api/references/attachments/' + attachment.id, {method:'DELETE'});
    expect(removed.ok).toBe(true);
    expect((await post('/api/references/resolve', {sources:[attachment],budget:100})).status).toBe(400);
    expect(await fs.readFile(path.join(documents,name), 'utf8')).toBe('仓库笔记');
  });

  it('reads the full prefixed model catalog and isolates credentials for new, saved, cleared and moved drafts', async () => {
    const getConfig = () => fetch(base+'/api/config').then(response=>response.json());
    const config = await getConfig();
    const saved = config.services.find(service=>service.id===config.selection.serviceId);
    const endpoint = mockBase.replace('/v1','/compatible/tenant/v1')+'/chat/completions/';
    const probe = body => post('/api/model-services/probe',{revision:config.revision,...body});
    catalog = Array.from({length:135},(_,index)=>({id:'catalog-'+index}));
    catalog[134] = {id:'catalog-134',name:'扩展档位',context_length:32768,top_provider:{max_completion_tokens:8192},reasoning_efforts:['none','minimal','high','max']};
    catalog.push({id:'catalog-134'}, {id:''}, {name:'missing ID'});
    const directory = await probe({service:{endpoint},key:'temporary-test-key'});
    expect(directory.ok).toBe(true);
    const result = await directory.json();
    expect(result).toMatchObject({kind:'catalog',configurationLimit:100});
    expect(result.models).toHaveLength(135);
    expect(result.models[0]).toEqual({id:'catalog-0',name:'catalog-0'});
    expect(result.models[134]).toMatchObject({capabilities:{contextTokens:32768,maxOutputTokens:8192,reasoning:{off:{parameter:'reasoning_effort',value:'none'},max:{value:'max'}}}});
    expect(probeRequests.at(-1)).toEqual({path:'/compatible/tenant/v1/models',method:'GET',authorization:'Bearer temporary-test-key',body:null});

    await probe({service:{id:saved.id,endpoint:saved.endpoint+'/chat/completions/'}});
    expect(probeRequests.at(-1).authorization).toBe('Bearer test-only-key');
    await probe({service:{id:saved.id,endpoint}});
    expect(probeRequests.at(-1).authorization).toBeUndefined();
    await probe({service:{endpoint:saved.endpoint}});
    expect(probeRequests.at(-1).authorization).toBeUndefined();
    await probe({service:{id:saved.id,endpoint:saved.endpoint},clearKey:true,key:'ignored-test-key'});
    expect(probeRequests.at(-1).authorization).toBeUndefined();
    reply = 'unsupported-limit';
    const generated = await probe({service:{id:saved.id,endpoint:saved.endpoint},key:'one-off-test-key',modelId:'manual-unlisted'});
    const probeResult = await generated.json();
    expect(probeResult).toEqual({kind:'generation',modelId:'manual-unlisted',elapsedMs:expect.any(Number)});
    expect(Number.isInteger(probeResult.elapsedMs) && probeResult.elapsedMs>=0).toBe(true);
    expect(probeRequests.slice(-2).map(item=>item.body)).toEqual([
      {model:'manual-unlisted',messages:[{role:'user',content:'Reply with OK.'}],stream:false,max_completion_tokens:32},
      {model:'manual-unlisted',messages:[{role:'user',content:'Reply with OK.'}],stream:false,max_tokens:32},
    ]);
    expect(probeRequests.at(-1)).toMatchObject({method:'POST',authorization:'Bearer one-off-test-key',path:'/v1/chat/completions'});
    expect(await getConfig()).toEqual(config);
    const disk = await fs.readFile(path.join(temp,'state','keys.json'),'utf8');
    expect(disk).not.toMatch(/temporary-test-key|one-off-test-key|ignored-test-key/);
  });

  it('stops at redirects, sanitizes upstream errors, enforces probe revision and origin, and times out', async () => {
    const config = await fetch(base+'/api/config').then(response=>response.json());
    const service={endpoint:mockBase};
    const body={service,revision:config.revision,key:'private-probe-test-key'};
    const probe = () => post('/api/model-services/probe',body);
    const forbidden = await fetch(base+'/api/model-services/probe',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:'https://unexpected.example'},body:JSON.stringify(body),
    });
    expect(forbidden.status).toBe(403);
    expect(probeRequests).toHaveLength(0);
    reply = 'http-error';
    const auth = await probe();
    expect(auth.status).toBe(502);
    const authError = (await auth.json()).error;
    expect(authError).toContain('HTTP 401');
    expect(authError).not.toContain('secret provider detail');
    reply = 'bad-catalog';
    const malformed = (await (await probe()).json()).error;
    expect(malformed).toContain('JSON');
    expect(malformed).not.toContain('private-upstream-detail');
    reply = 'redirect';
    const redirectCount = probeRequests.length;
    expect((await (await probe()).json()).error).toContain('跳转');
    expect(probeRequests).toHaveLength(redirectCount+1);
    reply = 'valid';
    catalog = [{id:'echo',name:'Authorization: Bearer private-probe-test-key'}];
    expect(JSON.stringify(await (await probe()).json())).not.toContain('private-probe-test-key');

    reply = 'slow-catalog';
    await expect(probeModelService({endpoint:mockBase,key:''},{timeoutMs:40})).rejects.toMatchObject({status:504});
    catalog = [];
    reply = 'delayed-catalog';
    const pending = probe();
    await expect.poll(()=>typeof releaseCatalog).toBe('function');
    await post('/api/config',{revision:config.revision,continuationLimit:101});
    releaseCatalog();
    expect((await pending).status).toBe(409);
    expect((await probe()).status).toBe(409);
  });

  it('sends only confirmed reasoning mappings and enforces the complete model budget without clipping messages', async () => {
    const config = await fetch(base+'/api/config').then(response=>response.json());
    const reasoning={off:{parameter:'reasoning_effort',value:'none'},max:{parameter:'reasoning.effort',value:'very_high'}};
    const model={id:'budget-model',name:'预算模型',contextTokens:1000,defaultReasoning:'off',capabilities:{contextTokens:10000,reasoning}};
    const saved = await (await post('/api/model-services',{revision:config.revision,service:{name:'预算服务',endpoint:mockBase,enabled:true,models:[model]}})).json();
    const selection = {serviceId:saved.services.find(service=>service.name==='预算服务').id,modelId:model.id};
    const messages=[{role:'system',content:'指令'},{role:'user',content:'完整选区，保留原内容。'}];
    const generate = async (body={}) => post('/api/generate',{selection,messages,...body});
    const fallback = await generate({reasoningEffort:'default'});
    await fallback.text();
    expect(fallback.ok).toBe(true);
    expect(lastBody).toMatchObject({messages,max_completion_tokens:250});
    expect(lastBody).not.toHaveProperty('reasoning_effort');
    const defaultModel = await generate();
    await defaultModel.text();
    expect(lastBody.reasoning_effort).toBe('none');
    const explicit = await generate({reasoningEffort:'max'});
    await explicit.text();
    expect(lastBody.reasoning).toEqual({effort:'very_high'});
    expect(lastBody).not.toHaveProperty('reasoning_effort');
    const rejectedBudget = await generate({messages:[...messages,{role:'assistant',content:'全'.repeat(400)}]});
    expect(rejectedBudget.status).toBe(413);
    expect((await rejectedBudget.json()).error).toContain('1000 token 上限');
    expect(lastBody.messages).toEqual(messages);
    await post('/api/model-services',{revision:saved.revision,service:{...saved.services.find(service=>service.id===selection.serviceId),models:[{...model,capabilities:undefined}]}});
    const revoked = await generate({reasoningEffort:'max'});
    expect(revoked.status).toBe(409);
    expect((await revoked.json()).error).toContain('已不可用');
    const safe = await generate({reasoningEffort:'default'});
    await safe.text();
    expect(lastBody).not.toHaveProperty('reasoning');
  });
  it('generates with explicitly declared ID-only model settings and restores the detected or unknown capacity on clear', async () => {
    const load=()=>fetch(base+'/api/config').then(res=>res.json());
    const model={id:'id-only-r5',name:'ID-only',manualReasoningLevels:['off','high'],defaultReasoning:'high',contextTokens:1000};
    const create=async(name,endpoint,models)=>{
      const {revision}=await load();
      const response=await post('/api/model-services',{revision,service:{name,endpoint,enabled:true,models}});
      expect(response.ok).toBe(true);
      const updated=await response.json();
      return updated.services.find(provider=>provider.name===name);
    };
    const provider=await create('手动设置',mockBase,[model]);
    const otherProvider=await create('独立同名',mockBase.replace('/v1','/alternate/v1'),[{id:model.id,name:model.name}]);
    const initial=await load();
    const selection={serviceId:provider.id,modelId:model.id};
    const activated=await post('/api/config',{revision:initial.revision,demo:false,selection});
    expect(activated.ok).toBe(true);
    const messages=[{role:'user',content:'完整文稿选区'}];
    const generate=(extra={})=>post('/api/generate',{selection,messages,...extra});
    const send=async(extra={})=>{
      const response=await generate(extra);
      expect(response.ok).toBe(true);
      expect(await response.text()).toContain('event: done');
      return lastBody;
    };
    expect(await send()).toMatchObject({model:model.id,messages,reasoning_effort:'high',max_completion_tokens:250});
    expect(await send({reasoningEffort:'off'})).toHaveProperty('reasoning_effort','none');
    expect(await send({reasoningEffort:'default'})).not.toHaveProperty('reasoning_effort');
    const unselected=await generate({reasoningEffort:'max'});
    expect(unselected.status).toBe(409);
    const isolated=await generate({selection:{serviceId:otherProvider.id,modelId:model.id},reasoningEffort:'high'});
    expect(isolated.status).toBe(409);
    reply='reject-effort';
    const rejected=await generate({reasoningEffort:'high'});
    expect(rejected.status).toBe(502);
    const error=await rejected.json();
    expect(error.error).toContain('HTTP 400');
    expect(error.error).toContain('调回默认');
    expect(error.error).not.toContain('private provider rejection');
    reply='valid';
    const oversized=await generate({messages:[{role:'user',content:'字'.repeat(700)}]});
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toContain('1000 token 上限');
    const saveModel=async(replacement)=>{
      const config=await load();
      const saved=await post('/api/model-services',{revision:config.revision,service:{...provider,models:[replacement]}});
      expect(saved.ok).toBe(true);
      const updated=await saved.json();
      return updated.services.find(item=>item.id===provider.id).models[0];
    };
    const detected={reasoning:{high:{parameter:'thinking.type',value:'enabled'}},contextTokens:6000};
    const cleared=await saveModel({...model,contextTokens:undefined,capabilities:detected});
    expect(cleared).not.toHaveProperty('contextTokens');
    const withDetected=await send({messages:[{role:'user',content:'字'.repeat(700)}]});
    expect(withDetected).toMatchObject({thinking:{type:'enabled'},max_completion_tokens:1500});
    expect(withDetected).not.toHaveProperty('reasoning_effort');
    const refreshed=await saveModel({...cleared,capabilities:undefined});
    expect(refreshed).toMatchObject({manualReasoningLevels:['off','high'],defaultReasoning:'high'});
    const withUnknown=await send();
    expect(withUnknown.reasoning_effort).toBe('high');
    expect(withUnknown).not.toHaveProperty('max_completion_tokens');
    const hardLimit=await generate({messages:[{role:'user',content:'字'.repeat(120001)}]});
    expect(hardLimit.status).toBe(400);
    expect((await hardLimit.json()).error).toContain('12 万');
  });
  it('enforces each model’s own output ceiling and restores provider-following output when cleared',async()=>{
    const load=()=>fetch(base+'/api/config').then(res=>res.json());
    const source=await load();
    const models=[
      {id:'custom-output',name:'自定义输出',contextTokens:1000,maxOutputTokens:500,capabilities:{maxOutputTokens:800}},
      {id:'follow-output',name:'跟随上游',capabilities:{contextTokens:1000,maxOutputTokens:1000}},
      {id:'unknown-output',name:'未知上游'},
    ];
    const response=await post('/api/model-services',{revision:source.revision,service:{name:'单独输出上限',endpoint:mockBase,enabled:true,models}});
    expect(response.ok).toBe(true);
    const config=await response.json();
    const provider=config.services.find(service=>service.name==='单独输出上限');
    const messages=[{role:'user',content:'短输入'}];
    const generate=(modelId,override={})=>post('/api/generate',{selection:{serviceId:provider.id,modelId},messages,...override});
    const successful=async(modelId,override)=>{
      const response=await generate(modelId,override);
      expect(response.ok).toBe(true);
      expect(await response.text()).toContain('event: done');
      return lastBody;
    };
    expect(await successful('custom-output')).toHaveProperty('max_completion_tokens',500);
    reply='output-capped';
    const nonStreamCapped=await (await generate('custom-output')).text();
    expect(nonStreamCapped).toContain('已达到最大输出长度');
    expect(nonStreamCapped).not.toContain('event: done');
    expect(nonStreamCapped).not.toContain('截断的回复');
    reply='unsupported-output-limit';
    const legacyParam=await successful('custom-output');
    expect(legacyParam).toHaveProperty('max_tokens',500);
    expect(legacyParam).not.toHaveProperty('max_completion_tokens');
    reply='valid';
    const oversized=await generate('custom-output',{messages:[{role:'user',content:'字'.repeat(180)}]});
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).error).toContain('含 500 输出预留');
    const inherited=await successful('follow-output');
    expect(inherited.max_completion_tokens).toBeGreaterThan(500);
    expect(inherited.max_completion_tokens+Buffer.byteLength(JSON.stringify(inherited))+64+16*messages.length).toBeLessThanOrEqual(1000);
    const unknown=await successful('unknown-output');
    expect(unknown).not.toHaveProperty('max_completion_tokens');
    const current=await load();
    const cleared=await post('/api/model-services',{revision:current.revision,service:{...provider,models:models.map(({maxOutputTokens,...model})=>model)}});
    expect(cleared.ok).toBe(true);
    const restored=await successful('custom-output');
    expect(restored.max_completion_tokens).toBeGreaterThan(500);
    expect(restored.max_completion_tokens).toBeLessThanOrEqual(800);
  });

  it('routes the explicitly selected service with its own key and rejects disabled services',async()=>{
    const create=async(name,endpoint,key)=>{
      const before=await (await fetch(base+'/api/config')).json();
      const response=await post('/api/model-services',{revision:before.revision,key,service:{name,endpoint,enabled:true,models:[{id:'shared-model',name}]}});
      expect(response.ok).toBe(true);const updated=await response.json();
      return updated.services.find(service=>service.name===name);
    };
    const a=await create('HTTP service A',mockBase,'isolated-key-A');
    const b=await create('HTTP service B',mockBase.replace('/v1','/second/v1'),'isolated-key-B');
    await post('/api/config',{demo:false,selection:{serviceId:b.id,modelId:'shared-model'}});
    const bResponse=await post('/api/generate',{messages:[{role:'user',content:'connection contract only'}]});
    await bResponse.text();expect(bResponse.ok).toBe(true);expect(lastAuthorization).toBe('Bearer isolated-key-B');expect(lastPath).toBe('/second/v1/chat/completions');
    const aResponse=await post('/api/generate',{selection:{serviceId:a.id,modelId:'shared-model'},messages:[{role:'user',content:'explicit request snapshot'}]});
    await aResponse.text();expect(aResponse.ok).toBe(true);expect(lastAuthorization).toBe('Bearer isolated-key-A');expect(lastPath).toBe('/v1/chat/completions');
    const current=await (await fetch(base+'/api/config')).json();
    await post('/api/model-services',{revision:current.revision,service:{...a,enabled:false}});
    const rejected=await post('/api/generate',{selection:{serviceId:a.id,modelId:'shared-model'},messages:[{role:'user',content:'must not reach upstream'}]});
    expect(rejected.status).toBe(400);expect((await rejected.json()).error).toContain('已停用');
    expect(lastBody.messages[0].content).toBe('explicit request snapshot');
    const disk=await fs.readFile(path.join(temp,'state/model.json'),'utf8');expect(disk).not.toContain('isolated-key');
  });
  it("persists annotations independently and prevents stale metadata replacement", async () => {
    await post("/api/file", {
      path: "annotations.md",
      text: "第一句。第二句。",
      baseline: null,
    });
    const initial = await (
      await fetch(base + "/api/annotations?source=document&file=annotations.md")
    ).json();
    expect(initial.revision).toBe(0);
    const annotation = {
      id: "one",
      source: "document",
      file: "annotations.md",
      from: 0,
      to: 4,
      original: "第一句。",
      note: "只处理这句",
      stale: false,
      createdAt: "2026-11-15T00:00:00Z",
    };
    const saved = await post("/api/annotations", {
      source: "document",
      file: "annotations.md",
      revision: 0,
      fingerprint: "a".repeat(64),
      items: [annotation],
    });
    expect(saved.ok).toBe(true);
    const conflict = await post("/api/annotations", {
      source: "document",
      file: "annotations.md",
      revision: 0,
      fingerprint: "a".repeat(64),
      items: [],
    });
    expect(conflict.status).toBe(409);
    const loaded = await (
      await fetch(base + "/api/annotations?source=document&file=annotations.md")
    ).json();
    expect(loaded.items[0].note).toBe("只处理这句");
    expect(loaded.revision).toBe(1);
    expect(
      (await (await fetch(base + "/api/file?path=annotations.md")).json()).text,
    ).toBe("第一句。第二句。");
  });
  it("isolates scratch annotations from document annotations and validates ranges", async () => {
    const annotation = {
      id: "scratch-one",
      source: "scratch",
      file: "自由草稿",
      from: 0,
      to: 2,
      original: "草稿",
      note: "一个问题",
      stale: false,
      createdAt: "2026-11-15T00:00:00Z",
    };
    const saved = await post("/api/annotations", {
      source: "scratch",
      file: "自由草稿",
      revision: 0,
      fingerprint: "b".repeat(64),
      items: [annotation],
    });
    expect(saved.ok).toBe(true);
    const malformed = await post("/api/annotations", {
      source: "scratch",
      file: "自由草稿",
      revision: 1,
      fingerprint: "b".repeat(64),
      items: [{ ...annotation, to: 100 }],
    });
    expect(malformed.status).toBe(400);
    expect(
      (await (await fetch(base + "/api/annotations?source=scratch")).json())
        .items[0].original,
    ).toBe("草稿");
  });
  it("forwards a two-annotation request through the actual model adapter", async () => {
    const sample = {
      source: "document",
      file: "test.md",
      from: 0,
      to: 2,
      original: "片段",
      note: "第一条备注",
    };
    const messages = annotationMessages(
      [
        { ...sample, id: "a" },
        { ...sample, id: "b", note: "第二条备注" },
      ],
      "逐条讨论",
      [],
    );
    const response = await post("/api/generate", { messages });
    expect(await response.text()).toContain("event: done");
    expect(lastBody.messages).toEqual(messages);
    expect(lastBody.messages.at(-1).content).toContain("第二条备注");
  });
  it("persists a custom continuation limit and rejects invalid values", async () => {
    const response = await post("/api/config", {
      endpoint: mockBase,
      model: "local-contract-stub",
      demo: false,
      continuationLimit: 30,
    });
    expect(response.ok).toBe(true);
    expect((await response.json()).continuationLimit).toBe(30);
    expect(
      JSON.parse(await fs.readFile(path.join(temp, "state/model.json"), "utf8"))
        .continuationLimit,
    ).toBe(30);
    const invalid = await post("/api/config", {
      endpoint: mockBase,
      model: "local-contract-stub",
      demo: false,
      continuationLimit: 0,
    });
    expect(invalid.status).toBe(400);
    expect(
      (await (await fetch(base + "/api/config")).json()).continuationLimit,
    ).toBe(30);
  });
  it("persists scratch as a workspace Markdown file and rejects a stale autosave", async () => {
    const initial = await (await fetch(base + "/api/scratch")).json();
    expect(initial.text).toBe("");
    expect(initial.path).toBe("自由草稿.md");
    expect(initial.hash).toBe(null);
    await expect(fs.stat(path.join(temp, "documents/自由草稿.md"))).rejects.toHaveProperty('code', 'ENOENT');
    const saved = await post("/api/scratch", {
      text: "独立草稿。",
      baseline: initial.hash,
    });
    expect(saved.ok).toBe(true);
    const loaded = await (await fetch(base + "/api/scratch")).json();
    expect(loaded.text).toBe("独立草稿。");
    const stale = await post("/api/scratch", {
      text: "过时覆盖",
      baseline: null,
    });
    expect(stale.status).toBe(409);
    expect((await (await fetch(base + "/api/scratch")).json()).text).toBe(
      "独立草稿。",
    );
    expect(await fs.readFile(path.join(temp, "documents/自由草稿.md"), "utf8")).toBe(
      "独立草稿。",
    );
    expect((await (await fetch(base + "/api/file?path=" + encodeURIComponent("自由草稿.md"))).json()).text).toBe("独立草稿。");
  });
  it("preserves a scratch file's CRLF and BOM when saving through the scratch editor", async () => {
    const first = await (await fetch(base + "/api/scratch")).json();
    const formatted = await (await post("/api/file", {
      path: "自由草稿.md", text: "# 草稿\n\n原有想法。\n", baseline: first.hash, eol: "CRLF", bom: true,
    })).json();
    const saved = await post("/api/scratch", {text:"# 草稿\n\n新的想法。\n",baseline:formatted.hash});
    expect(saved.ok).toBe(true);
    expect(await fs.readFile(path.join(temp,"documents/自由草稿.md"),"utf8")).toBe("\uFEFF# 草稿\r\n\r\n新的想法。\r\n");
  });
  it("creates, changes, reorders and deletes independent outline nodes without touching the body", async () => {
    const file = "independent-outline.md", text = "# 原文\n\n正文保持原样。";
    await post("/api/file", {path:file,text,baseline:null});
    const read = async () => (await fetch(base + "/api/writing-outline?file=" + file)).json();
    expect(await read()).toEqual({revision:0,initialized:false,nodes:[]});
    const a = {id:"a",title:"第一节",description:"先举例",level:2,targetHeading:null};
    const b = {...a,id:"b",title:"第二节"};
    expect((await post("/api/writing-outline",{file,nodes:[a,b],revision:0})).ok).toBe(true);
    expect((await post("/api/writing-outline",{file,nodes:[b,{...a,title:"改名",description:"再解释"}],revision:1})).ok).toBe(true);
    expect((await read()).nodes.map(node=>node.title)).toEqual(["第二节","改名"]);
    expect((await post("/api/writing-outline",{file,nodes:[a],revision:1})).status).toBe(409);
    expect((await post("/api/writing-outline",{file,nodes:[],revision:2})).ok).toBe(true);
    expect(await read()).toEqual({revision:3,initialized:true,nodes:[]});
    expect((await (await fetch(base+"/api/file?path="+file)).json()).text).toBe(text);
    expect((await post("/api/writing-outline",{file,nodes:[null],revision:3})).status).toBe(400);
    expect((await post("/api/writing-outline",{file,nodes:[a,a],revision:3})).status).toBe(400);
    expect((await post("/api/writing-outline",{file,nodes:[{...a,title:"换\n行"}],revision:3})).status).toBe(400);
  });
  it("keeps independent writing descriptions for each document and serializes concurrent saves", async () => {
    expect(
      (
        await post("/api/file", {
          path: "outline.md",
          text: "# 标题\n\n## 章节",
          baseline: null,
        })
      ).ok,
    ).toBe(true);
    const results = await Promise.all([
      post("/api/outline", {
        file: "outline.md",
        key: "node-a",
        description: "说明观点A。",
      }),
      post("/api/outline", {
        file: "outline.md",
        key: "node-b",
        description: "用具体材料说明B。",
      }),
    ]);
    expect(results.every((response) => response.ok)).toBe(true);
    const plans = await (
      await fetch(base + "/api/outline?file=outline.md")
    ).json();
    expect(plans).toEqual({
      "node-a": "说明观点A。",
      "node-b": "用具体材料说明B。",
    });
    expect(
      (await (await fetch(base + "/api/file?path=outline.md")).json()).text,
    ).toBe("# 标题\n\n## 章节");
  });
  it("reports the owning project and process for launcher readiness checks", async () => {
    const response = await fetch(base + "/api/health");
    expect(response.status).toBe(200);
    const health = await response.json();
    expect(health.app).toBe("hive-writing-prototype");
    expect(health.ready).toBe(true);
    expect(health.backend).toBe("dotnet");
    expect(health.pid).toBe(backend.child.pid);
    expect(health.project).toBe(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    );
  });
  it("streams valid output and forwards latest supplied messages", async () => {
    const messages = [
      { role: "system", content: "Return JSON" },
      { role: "user", content: "最新手改正文" },
    ];
    const response = await post("/api/generate", { messages });
    const text = await response.text();
    expect(text).toContain("event: chunk");
    expect(text).toContain("一段完整的短文。");
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(lastBody.messages).toEqual(messages);
    expect(lastBody.model).toBe("local-contract-stub");
  });
  it("reports incomplete streams as errors without a successful done event", async () => {
    reply = "truncated";
    const response = await post("/api/generate", {
      messages: [{ role: "user", content: "test" }],
    });
    const text = await response.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain("event: done");
  });
  it("handles provider errors without returning provider response details", async () => {
    reply = "http-error";
    const response = await post("/api/generate", {
      messages: [{ role: "user", content: "test" }],
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret provider detail");
  });
  it("does not persist or return API keys", async () => {
    const response = await fetch(base + "/api/config"),
      data = await response.json();
    expect(data.hasKey).toBe(true);
    expect(data.key).toBeUndefined();
    expect(
      await fs.readFile(path.join(temp, "state/model.json"), "utf8"),
    ).not.toContain("test-only-key");
  });
  it("aborts upstream work when the client stops the request", async () => {
    reply = "slow";
    const abort = new AbortController();
    const responsePromise = fetch(base + "/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "test" }] }),
      signal: abort.signal,
    });
    // Wait for the actual upstream connection, rather than guessing the model latency.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("upstream not reached")),
        3000,
      );
      mock.once("request", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    abort.abort();
    await expect(responsePromise).rejects.toThrow();
    await expect.poll(() => aborted, { timeout: 3000 }).toBe(true);
  });
  it("rejects unexpected origins and oversized context", async () => {
    const cross = await fetch(base + "/api/file", {
      method: "POST",
      headers: {
        Origin: "https://unrelated.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    const big = await post("/api/generate", {
      messages: [{ role: "user", content: "字".repeat(120001) }],
    });
    expect(big.status).toBe(400);
  });
  it("round trips a file through the HTTP API and prevents stale saves", async () => {
    const created = await post("/api/file", {
      path: "http.md",
      text: "# 正文\n",
      baseline: null,
    });
    expect(created.ok).toBe(true);
    const loaded = await (await fetch(base + "/api/file?path=http.md")).json();
    expect(loaded.text).toBe("# 正文\n");
    expect(
      (
        await post("/api/file", {
          path: "http.md",
          text: "最新正文",
          baseline: loaded.hash,
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await post("/api/file", {
          path: "http.md",
          text: "旧基线覆盖",
          baseline: loaded.hash,
        })
      ).status,
    ).toBe(409);
  });
  it("supports explorer create, rename, soft delete and restore through workspace-bound APIs",async()=>{
    const created=await(await post('/api/explorer',{action:'create',type:'file'})).json();
    const renamed=await post('/api/explorer',{action:'rename',path:created.path,name:'文件整理验收.md'});expect(renamed.ok).toBe(true);
    const moved=await(await post('/api/explorer',{action:'trash',path:'文件整理验收.md'})).json();
    expect((await(await fetch(base+'/api/explorer/trash')).json()).some(item=>item.id===moved.id)).toBe(true);
    expect((await post('/api/explorer',{action:'restore',id:moved.id})).ok).toBe(true);
    expect((await fetch(base+'/api/file?path='+encodeURIComponent('文件整理验收.md'))).ok).toBe(true);
  });
  it("deletes a single trashed item by id through the HTTP API",async()=>{
    const created=await(await post('/api/explorer',{action:'create',type:'file'})).json();
    await post('/api/explorer',{action:'rename',path:created.path,name:'单条删除验收.md'});
    const moved=await(await post('/api/explorer',{action:'trash',path:'单条删除验收.md'})).json();
    const deleted=await post('/api/explorer/trash/delete',{ids:[moved.id]});
    expect(deleted.ok).toBe(true);
    expect((await deleted.json()).deletedIds).toEqual([moved.id]);
    expect((await(await fetch(base+'/api/explorer/trash')).json()).some(item=>item.id===moved.id)).toBe(false);
    expect((await post('/api/explorer/trash/delete',{ids:[moved.id]})).status).toBe(404);
    expect((await post('/api/explorer/trash/delete',{})).status).toBe(400);
  });
  it("switches folders through HTTP, synchronizes external files, and rejects stale workspace writes",async()=>{
    const original=await(await fetch(base+'/api/workspace')).json();
    const other=path.join(temp,'other-workspace');await fs.mkdir(other);
    await fs.writeFile(path.join(other,'outside.md'),'# 外部文件\n');
    try{
      const changedResponse=await post('/api/workspace',{root:other,revision:original.revision});
      expect(changedResponse.ok).toBe(true);
      const changed=await changedResponse.json();
      const sync=await(await post('/api/workspace/sync',{paths:['outside.md','deleted.md']})).json();
      expect(sync.entries.some(entry=>entry.path==='outside.md')).toBe(true);
      expect(sync.files[0].text).toBe('# 外部文件\n');expect(sync.files[1].error).toContain('删除');
      const unchanged=await(await post('/api/workspace/sync',{paths:['outside.md'],baselines:{'outside.md':sync.files[0].hash}})).json();
      expect(unchanged.files[0]).toEqual({path:'outside.md',hash:sync.files[0].hash,unchanged:true});
      const before=await fs.stat(path.join(other,'outside.md'));
      await fs.writeFile(path.join(other,'outside.md'),'# 外部更新\n');
      await fs.utimes(path.join(other,'outside.md'),before.atime,before.mtime);
      const updated=await(await post('/api/workspace/sync',{paths:['outside.md'],baselines:{'outside.md':sync.files[0].hash}})).json();
      expect(updated.files[0].hash).not.toBe(sync.files[0].hash);
      expect(updated.files[0].text).toBe('# 外部更新\n');
      await fs.writeFile(path.join(other,'format.md'),'\uFEFF第一行\r\n第二行\r\n');
      const formatted=(await(await post('/api/workspace/sync',{paths:['format.md']})).json()).files[0];
      expect(formatted).toMatchObject({text:'第一行\n第二行\n',eol:'CRLF',bom:true});
      expect((await(await post('/api/workspace/sync',{paths:['format.md'],baselines:{'format.md':formatted.hash}})).json()).files[0]).toEqual({path:'format.md',hash:formatted.hash,unchanged:true});
      const stale=await fetch(base+'/api/file',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':original.id},body:JSON.stringify({path:'outside.md',text:'stale tab',baseline:updated.files[0].hash})});
      const staleExplorer=await fetch(base+'/api/explorer',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':original.id},body:JSON.stringify({action:'trash',path:'outside.md'})});
      expect(staleExplorer.status).toBe(409);expect(stale.status).toBe(409);expect(await fs.readFile(path.join(other,'outside.md'),'utf8')).toBe('# 外部更新\n');
      expect((await post('/api/workspace',{root:other,revision:original.revision})).status).toBe(409);
      const valid=await fetch(base+'/api/file',{method:'POST',headers:{'Content-Type':'application/json','X-Hive-Workspace':changed.id},body:JSON.stringify({path:'outside.md',text:'current tab',baseline:updated.files[0].hash})});
      expect(valid.ok).toBe(true);
    }finally{
      const current=await(await fetch(base+'/api/workspace')).json();
      await post('/api/workspace',{root:original.root,autoSave:original.autoSave,revision:current.revision});
    }
  });

});
