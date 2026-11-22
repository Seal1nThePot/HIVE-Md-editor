import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { workspaceStore } from "./workspace.mjs";
import { modelConfigStore } from "./model-config.mjs";
import {imageStore,MAX_IMAGE_BYTES} from './images.mjs';
import {importStore,MAX_MARKDOWN_BYTES} from './imports.mjs';
import {referenceAttachmentStore} from './reference-attachments.mjs';
import {resolveReferences} from './references.mjs';
import {generationPayload} from './generation-options.mjs';
import {probeModelService,sendChatCompletion,upstreamHttpError,upstreamJson} from './model-probe.mjs';
import {templateStore} from './templates.mjs';
import {desktopShell} from './desktop-shell.mjs';
import { registerDocumentRoutes } from './document-routes.mjs';
import { registerAiTools } from './ai-tools/index.mjs';
import { registerHistoryRoutes } from './history/history-routes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const root = path.resolve(
  process.env.HIVE_DOCUMENTS || path.join(project, "documents"),
);
const local = path.resolve(
  process.env.HIVE_STATE_DIR || path.join(project, ".local"),
);
let port = Number(process.env.HIVE_PORT ?? 4324);
await fs.mkdir(root, { recursive: true });
const modelSettings = await modelConfigStore(local, {envKey:process.env.HIVE_API_KEY || ""});
const desktopFiles=process.env.HIVE_DESKTOP_SHELL==='1'&&process.send?desktopShell(process):null;
const spaces = await workspaceStore(local, root, {
  revealFile:desktopFiles?.revealFile,repositoryManifestDirectory:process.env.HIVE_APP_DATA_DIR||local,
}).catch(async error => {
  if (error.code === 'HIVE_STATE_CORRUPT' && desktopFiles) {
    await new Promise(resolve => process.send({type:'hive-startup-error',message:error.message}, () => resolve()));
  }
  throw error;
});
const templates = await templateStore(process.env.HIVE_TEMPLATES_DIR || path.join(local,'templates'),path.join(project,'templates'),{
  sourceDirectory:process.env.HIVE_TEMPLATES_SOURCE || (!project.includes('.asar')?path.join(project,'templates'):undefined),
  openDirectory:desktopFiles?.openDirectory,
});
const app = express();
app.disable("x-powered-by");
app.use("/api", (req, res, next) => {
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
    return res.status(403).json({ error: "只允许本机访问。" });
  const origin = req.headers.origin;
  if (
    origin &&
    ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)
  )
    return res.status(403).json({ error: "请求来源不匹配。" });
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "3mb" }));
app.get('/api/templates',async(_req,res)=>res.json(await templates.list()));
app.get('/api/templates/:id',async(req,res)=>{
  const record=await templates.read(req.params.id);
  if(req.query.colorsOnly==='1')return res.json(record);
  const iconPack=await templates.readIcons(req.params.id);
  if(req.query.iconPackRevision===iconPack.packRevision)return res.json({...record,iconPackUnchanged:true});
  res.json({...record,iconPack});
});
app.post('/api/templates/:id',async(req,res)=>res.json(await templates.save(req.params.id,req.body)));
app.post('/api/templates/:id/open',async(req,res)=>res.json(await templates.open(req.params.id)));
app.get('/api/templates/:id/icons',async(req,res)=>res.json(await templates.readIcons(req.params.id)));
app.post('/api/templates/:id/icons',async(req,res)=>res.json(await templates.saveIcons(req.params.id,req.body)));
app.get('/api/workspace', (_req,res)=>res.json(spaces.read()));
const workspaceRoutes = new Set(['writing-outline','annotations','scratch','outline','tree','file','folder','rename','workspace','explorer','images','image-file','references','import','history']);
const mutationQueues=new Map();
app.use('/api', (req,res,next)=>{
  if(!workspaceRoutes.has(req.path.split('/')[1])) return next();
  try {
    req.workspace=spaces.capture(req.headers['x-hive-workspace']);
    if(!['POST','DELETE'].includes(req.method)||req.path==='/workspace/sync')return next();
    const id=req.workspace.id,previous=mutationQueues.get(id)||Promise.resolve();
    let release;const done=new Promise(resolve=>{release=resolve;});mutationQueues.set(id,done);
    let released=false,started=false;const finish=()=>{if(released)return;released=true;release();if(mutationQueues.get(id)===done)mutationQueues.delete(id);};
    const json=res.json.bind(res);res.json=(...args)=>{try{return json(...args);}finally{finish();}};
    res.once('finish',finish);res.once('close',()=>{if(!started)finish();});
    previous.catch(()=>{}).then(()=>{if(res.destroyed){finish();return;}started=true;next();});
  }catch(error){next(error);}
});
app.post('/api/workspace', async(req,res)=>res.json(await spaces.update(req.body)));
app.post('/api/workspace/repositories', async(req,res)=>res.json(await spaces.manage(req.body)));
app.post('/api/references/resolve',async(req,res)=>res.json(await resolveReferences(req.workspace,req.body)));
app.post('/api/references/attachments',express.raw({type:'application/octet-stream',limit:MAX_MARKDOWN_BYTES}),async(req,res)=>{
  res.json(await referenceAttachmentStore(req.workspace.state).add(req.query.name,req.body));
});
app.delete('/api/references/attachments/:id',async(req,res)=>{
  await referenceAttachmentStore(req.workspace.state).remove(req.params.id);
  res.json({ok:true});
});
registerDocumentRoutes(app, spaces);
registerHistoryRoutes(app);
app.get("/api/writing-outline", async (req, res) => {
  await req.workspace.files.read(req.query.file);
  res.json(await req.workspace.nodes.read(req.query.file));
});
app.post("/api/writing-outline", async (req, res) => {
  await req.workspace.files.read(req.body.file);
  res.json(
    await req.workspace.nodes.save(req.body.file, req.body.nodes, req.body.revision),
  );
});
async function annotationIdentity(req, source, file) {
  if (source === "document") {
    await req.workspace.files.read(file);
    return { source, file };
  }
  if (source === "scratch") return { source, file: "自由草稿" };
  throw Object.assign(new Error("标注来源无效。"), { status: 400 });
}
app.get("/api/annotations", async (req, res) => {
  const identity = await annotationIdentity(req, req.query.source, req.query.file);
  res.json(await req.workspace.annotations.read(identity.source, identity.file));
});
app.post("/api/annotations", async (req, res) => {
  const identity = await annotationIdentity(req, req.body.source, req.body.file);
  res.json(await req.workspace.annotations.save({ ...req.body, ...identity }));
});
app.get("/api/outline", async (req, res) => {
  await req.workspace.files.read(req.query.file);
  res.json(await req.workspace.outlines.read(req.query.file));
});
app.post("/api/outline", async (req, res) => {
  await req.workspace.files.read(req.body.file);
  res.json(
    await req.workspace.outlines.save(
      req.body.file,
      req.body.key,
      req.body.description,
    ),
  );
});
app.get("/api/health", (_req, res) =>
  res.json({
    app: "hive-writing-prototype",
    pid: process.pid,
    project,
    ready: true,
  }),
);
app.get('/api/explorer/trash',async(req,res)=>res.json(await req.workspace.explorer.listTrash()));
app.get('/api/explorer/trash/document',async(req,res)=>res.json(await req.workspace.explorer.readTrashedDocument(req.query.id)));
app.post('/api/explorer/trash/preview',async(req,res)=>res.json(await req.workspace.explorer.previewTrash(req.body.days)));
app.post('/api/explorer/trash/purge',async(req,res)=>res.json(await req.workspace.explorer.purgeTrash(req.body.token)));
app.post('/api/explorer/trash/delete',async(req,res)=>res.json(await req.workspace.explorer.deleteTrash(req.body?.ids)));
app.get('/api/explorer/search',async(req,res)=>res.json(await req.workspace.explorer.search(req.query.folder,req.query.query)));
app.post('/api/explorer',async(req,res)=>res.json(await req.workspace.explorer.manage(req.body)));
app.post('/api/import',express.raw({type:'application/octet-stream',limit:MAX_IMAGE_BYTES}),async(req,res)=>{
  res.json(await importStore(req.workspace).store(req.query.name,req.body,req.query.parent));
});
app.get('/api/import',async(req,res)=>res.json(await importStore(req.workspace).list()));
app.get('/api/import/references',async(req,res)=>res.json(await importStore(req.workspace).references(req.query.path)));
app.get('/api/import/image',async(req,res)=>{
  const image=await importStore(req.workspace).read(req.query.path);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  res.type(image.mime).send(image.buffer);
});
app.post('/api/images',express.raw({type:'application/octet-stream',limit:MAX_IMAGE_BYTES}),async(req,res)=>{
  res.json(await imageStore(req.workspace).store(req.query.document,req.query.name,req.body));
});
app.get('/api/image-file/info',async(req,res)=>{
  const image=await imageStore(req.workspace).readFile(req.query.path);
  res.json({path:req.query.path,mime:image.mime,bytes:image.buffer.length});
});
app.get('/api/image-file',async(req,res)=>{
  if(!req.query.workspace||req.query.workspace!==req.workspace.id)return res.status(409).json({error:'图片所属写作空间已变化。'});
  const image=await imageStore(req.workspace).readFile(req.query.path);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  res.type(image.mime).send(image.buffer);
});
app.get('/api/images',async(req,res)=>{
  if(!req.query.workspace||req.query.workspace!==req.workspace.id)return res.status(409).json({error:'图片所属写作空间已变化。'});
  const image=await imageStore(req.workspace).read(req.query.document,req.query.path);
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  res.type(image.mime).send(image.buffer);
});
app.get("/api/config", (_req, res) => res.json(modelSettings.read()));
app.post("/api/config", async (req, res) => res.json(await modelSettings.update(req.body)));
app.post("/api/model-services", async (req, res) => res.json(await modelSettings.upsert(req.body)));
app.post("/api/model-services/remove", async (req, res) => res.json(await modelSettings.remove(req.body)));
app.post("/api/model-services/reorder", async (req, res) => res.json(await modelSettings.reorder(req.body)));
registerAiTools(app,{spaces,modelSettings});
app.post("/api/model-services/probe", async (req, res) => {
  const route = modelSettings.resolveProbe(req.body);
  const abort = new AbortController();
  const stop = () => abort.abort();
  res.once('close', stop);
  try {
    const result = await probeModelService(route, {signal: abort.signal});
    modelSettings.checkRevision(req.body.revision);
    if (!res.destroyed) res.json(result);
  } catch (error) {
    if (!res.destroyed) throw error;
  } finally {
    res.off('close', stop);
  }
});
app.post("/api/generate", async (req, res) => {
  const route = {...modelSettings.resolve(req.body.selection), sessionId:req.get('x-hive-model-session')};
  const {payload, outputLimit} = generationPayload(route, req.body);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const timeout = setTimeout(() => abort.abort(), 120000);
  let headersSent = false;
  const emit = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  function checkFinish(reason) {
    if (reason === 'length') throw new Error('本轮已达到最大输出长度，请调整后重试。');
    if (reason && reason !== 'stop') throw new Error('生成未完整结束，请重试。');
  }
  try {
    const upstream = await sendChatCompletion(route, payload, abort.signal, outputLimit);
    if (!upstream.ok) {
      if (!upstream.bodyUsed) void upstream.body?.cancel().catch(() => {});
      const hint = payload.reasoning_effort || payload.reasoning || payload.thinking ? '可将推理强度调回默认后重试。' : '';
      throw new Error(upstreamHttpError(upstream.status, false) + hint);
    }
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    headersSent = true;
    if (
      !(upstream.headers.get("content-type") || "").includes(
        "text/event-stream",
      )
    ) {
      const value = await upstreamJson(upstream, 8 * 1024 * 1024);
      const choice = value?.choices?.[0];
      const text = choice?.message?.content;
      if (value?.error || typeof text !== "string" || !text)
        throw new Error("端点未返回可用正文。");
      checkFinish(choice.finish_reason);
      emit("chunk", text);
      emit("done", {});
      return res.end();
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let received = false;
    let finished = false;
    function parse(block) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return;
      if (data === "[DONE]") {
        finished = true;
        return;
      }
      let value;
      try { value = JSON.parse(data); }
      catch { throw new Error('模型端点返回了无法解析的流式响应。'); }
      if (value.error) throw new Error("模型端点返回错误，请检查配置后重试。");
      const delta = value.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        received = true;
        emit("chunk", delta);
      }
      if (value.choices?.[0]?.finish_reason) {
        checkFinish(value.choices[0].finish_reason);
        finished = true;
      }
    }
    for await (const chunk of upstream.body) {
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      let i;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) parse(buffer);
    if (!received || !finished)
      throw new Error("模型响应中断或未返回正文，未生成可采纳建议。");
    emit("done", {});
    res.end();
  } catch (error) {
    if (!res.destroyed) {
      const message =
        error.name === "AbortError"
          ? "请求已停止或超时。"
          : error.message === "fetch failed"
            ? "无法连接模型端点，请检查本机网络及端点地址。"
            : error.message;
      if (headersSent) {
        emit("error", message);
        res.end();
      } else res.status(502).json({ error: message });
    }
  } finally {
    clearTimeout(timeout);
  }
});
app.use("/api", (_req, res) => res.status(404).json({ error: "接口不存在。" }));
app.use((error, _req, res, _next) => {
  res
    .status(
      error.status ||
        (error.code === "ENOENT" ? 404 : error.code === "EEXIST" ? 409 : 500),
    )
    .json({
      ...(error.code === 'HIVE_STATE_CORRUPT' ? {code:error.code} : {}),
      error:
        error.code === "ENOENT"
          ? "文件不存在，请刷新文件列表。"
          : error.code === "EEXIST"
            ? "同名文件已存在，已阻止覆盖。"
            : error.message || "本地操作失败。",
    });
});
if (process.argv.includes("--production")) {
  app.use(express.static(path.join(project, "dist")));
  app.get("/", (_req, res) =>
    res.sendFile(path.join(project, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: project,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, "127.0.0.1", () => {
  port = server.address().port;
  console.log(`HIVE ready: http://127.0.0.1:${port}\nDocuments: ${spaces.read().root}`);
  if (process.send) process.send({ type: 'hive-ready', port });
});
let stopping=false;
function shutdown() {
  if(stopping)return;stopping=true;
  const httpClosed=new Promise(resolve=>server.close(resolve));server.closeAllConnections();
  void Promise.all([httpClosed,templates.close(),spaces.close()]).then(()=>process.exit(0));
}
if (process.send) {
  process.on('message', message => { if (message?.type === 'hive-shutdown') shutdown(); });
  process.on('disconnect', shutdown);
}
server.on("error", (error) => {
  console.error(
    error.code === "EADDRINUSE"
      ? `端口 ${port} 已使用，请复用已运行的 HIVE，或设置 HIVE_PORT。`
      : error.message,
  );
  process.exit(1);
});
