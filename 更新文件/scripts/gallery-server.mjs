import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { selectModels, selectLoras, validateOptions, buildWorkflow, createPromptRecord } from './qwen-workflow.mjs';
import { LocalEngine, detectExistingComfy } from './local-engine.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.GALLERY_ROOT || path.join(scriptRoot, '..'));
const port = Number(process.env.GALLERY_PORT || 8765);
const engine = await LocalEngine.create(root, { initialUrl: process.env.COMFYUI_URL });
let comfyUrl = engine.url;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GALLERY_PORT 不正确');
const baseUrl = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([baseUrl, `http://localhost:${port}`, 'null']);
const data = JSON.parse(await readFile(path.join(root, 'data', 'pose-zh.json'), 'utf8'));
const poses = new Map(data.map(item => [item.id, item]));
const costumeData = JSON.parse(await readFile(path.join(root, 'data', 'costume-zh.json'), 'utf8'));
const costumes = new Map(costumeData.map(item => [item.id, item]));
let descriptions = new Map();
try {
  const dictionary = JSON.parse(await readFile(path.join(root, 'data', 'pose-descriptions.json'), 'utf8'));
  descriptions = new Map(Object.entries(dictionary.items || {}));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  console.warn('未找到姿势词条，将使用姿势原图和动作短名生成。');
}
const runtimeRoot = path.join(root, '.local');
await mkdir(runtimeRoot, { recursive: true });
const outputRoot = path.join(root, 'output');
await mkdir(outputRoot, { recursive: true });
const statePath = path.join(runtimeRoot, 'generation-state.json');
let saved = {};
try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.warn('旧任务记录无法读取，将新建记录。'); }
const references = new Map(Object.entries(saved.references || {}));
const jobs = new Map(Object.entries(saved.jobs || {}));
const poseUploads = new Map();
const costumeUploads = new Map();
let writing = Promise.resolve();
function saveState() {
  writing = writing.catch(() => {}).then(async () => {
    await writeFile(statePath + '.tmp', JSON.stringify({ references: Object.fromEntries(references), jobs: Object.fromEntries(jobs) }), 'utf8');
    await rename(statePath + '.tmp', statePath);
  });
  return writing;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function comfyFetch(endpoint, options = {}, timeout = 15000, targetUrl = comfyUrl) {
  try {
    return await fetch(targetUrl + endpoint, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new ApiError(503, '无法连接本机 ComfyUI，请先启动 ComfyUI，再点击重新检查。');
  }
}

async function comfyJson(endpoint, options, timeout, targetUrl = comfyUrl) {
  const response = await comfyFetch(endpoint, options, timeout, targetUrl);
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new ApiError(502, 'ComfyUI 返回了无法识别的数据，请检查服务地址。'); }
  if (!response.ok) {
    const detail = result.error?.message || result.error || result.message || `HTTP ${response.status}`;
    const nodeDetail = Object.values(result.node_errors || {}).flatMap(node => (node.errors || []).map(e => e.message + (e.details ? `：${e.details}` : ''))).join('；');
    throw new ApiError(502, `ComfyUI 拒绝了生成任务：${typeof detail === 'string' ? detail : JSON.stringify(detail)}${nodeDetail ? `；${nodeDetail}` : ''}`);
  }
  return result;
}

let modelInfo = null;
let modelChecked = 0;
let modelInfoUrl = null;
async function getModels(force = false, targetUrl = comfyUrl) {
  if (!force && modelInfo && modelInfoUrl === targetUrl && Date.now() - modelChecked < 60000) return modelInfo;
  const info = await comfyJson('/object_info', undefined, 25000, targetUrl);
  const result = { ...selectModels(info), loras: selectLoras(info) };
  if (targetUrl === comfyUrl) { modelInfo = result; modelInfoUrl = targetUrl; modelChecked = Date.now(); }
  return result;
}

const clientId = randomUUID();
const execution = new Map();
let socket;
let stopped = false;
let currentPrompt = null;
let reconnectTimer;
function connectProgress() {
  if (stopped) return;
  socket = new WebSocket(comfyUrl.replace(/^http/, 'ws') + '/ws?clientId=' + clientId);
  const connection = socket;
  socket.addEventListener('message', event => {
    if (connection !== socket) return;
    if (typeof event.data !== 'string') return;
    try {
      const { type, data } = JSON.parse(event.data);
      const id = data?.prompt_id || currentPrompt;
      if (type === 'execution_start') currentPrompt = data.prompt_id;
      if (!id || !jobs.has(id)) return;
      const item = execution.get(id) || {};
      if (type === 'execution_start' || type === 'executing') item.status = 'running';
      if (type === 'progress') item.progress = { value: data.value, max: data.max };
      if (type === 'execution_error' || type === 'execution_interrupted') { item.status = 'error'; item.error = friendlyError(data.exception_message || '任务被 ComfyUI 中断'); }
      execution.set(id, item);
    } catch {}
  });
  socket.addEventListener('error', () => {});
  socket.addEventListener('close', () => { if (!stopped && connection === socket) reconnectTimer = setTimeout(connectProgress, 5000); });
}
connectProgress();

function resetConnection() {
  comfyUrl = engine.url; modelInfo = null; modelChecked = 0;
  poseUploads.clear(); costumeUploads.clear(); currentPrompt = null; execution.clear();
  clearTimeout(reconnectTimer);
  const previous = socket; socket = null; previous?.close();
  connectProgress();
}
let activeSubmissions = 0;
let changingEngine = false;
function requireIdleEngine() {
  if (changingEngine || activeSubmissions || [...jobs.values()].some(job => !['completed', 'error'].includes(job.status))) throw new ApiError(409, '存在上传、连接切换或未完成的生图任务，请等待结束后再修改或停止引擎');
}

function friendlyError(message) {
  const text = String(message || '生成失败');
  if (/out of memory|allocation|显存/i.test(text)) return '显存不足。请降低图片尺寸，或在 ComfyUI 中释放其他模型后重试。';
  return text.slice(0, 1600);
}

function imageType(bytes) {
  if (bytes.length < 16) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { ext: 'png', mime: 'image/png' };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { ext: 'jpg', mime: 'image/jpeg' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

async function readBody(req, limit) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) throw new ApiError(413, `上传内容过大，请控制在 ${Math.round(limit / 1048576)} MB 以内。`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '请使用 JSON 格式提交任务');
  try { return JSON.parse((await readBody(req, 65536)).toString('utf8')); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, '请求数据格式不正确'); }
}

async function uploadImage(bytes, filename, subfolder) {
  const type = imageType(bytes);
  if (!type) throw new ApiError(415, '请选择有效的 PNG、JPEG 或 WebP 图片');
  const body = new FormData();
  body.set('image', new Blob([bytes], { type: type.mime }), filename);
  body.set('type', 'input');
  body.set('subfolder', subfolder);
  body.set('overwrite', 'true');
  const result = await comfyJson('/upload/image', { method: 'POST', body }, 30000);
  return (result.subfolder ? result.subfolder + '/' : '') + result.name;
}

async function uploadPose(pose) {
  if (poseUploads.has(pose.id)) return poseUploads.get(pose.id);
  const filename = path.resolve(root, pose.原图);
  if (!filename.startsWith(path.join(root, 'img') + path.sep)) throw new ApiError(400, '姿势图片路径不正确');
  const bytes = await readFile(filename);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const uploaded = await uploadImage(bytes, `${pose.id}-${hash}.png`, 'pose_gallery/poses');
  poseUploads.set(pose.id, uploaded);
  return uploaded;
}

async function uploadCostume(costume) {
  if (costumeUploads.has(costume.id)) return costumeUploads.get(costume.id);
  const filename = path.resolve(root, costume.原图);
  if (!filename.startsWith(path.join(root, 'costume', 'png') + path.sep)) throw new ApiError(400, '服装图片路径不正确');
  const bytes = await readFile(filename);
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const uploaded = await uploadImage(bytes, `${costume.id}-${hash}.png`, 'pose_gallery/costumes');
  costumeUploads.set(costume.id, uploaded);
  return uploaded;
}

async function archiveImages(id, images, targetUrl = comfyUrl) {
  for (const [index, image] of images.entries()) {
    if (image.localFilename) continue;
    const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: 'output' });
    const response = await comfyFetch('/view?' + params, undefined, 60000, targetUrl);
    if (!response.ok) throw new ApiError(502, '读取生成结果失败，正在重试保存到项目 output 文件夹');
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = imageType(bytes);
    if (!type) throw new ApiError(502, '生成结果不是有效图片，暂时无法保存');
    const filename = `${id.replace(/[^a-z\d-]/gi, '_')}-${index + 1}.${type.ext}`;
    const target = path.join(outputRoot, filename);
    await writeFile(target + '.tmp', bytes);
    await rename(target + '.tmp', target);
    image.localFilename = filename;
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const inspections = new Map();
function inspectJob(id) {
  if (!inspections.has(id)) {
    const inspection = inspectJobImpl(id).finally(() => inspections.delete(id));
    inspections.set(id, inspection);
  }
  return inspections.get(id);
}

async function inspectJobImpl(id) {
  const job = jobs.get(id);
  if (!job) throw new ApiError(404, '未找到这条生成记录，请重新开始生成');
  if (job.status === 'completed' || job.status === 'error') return jobResponse(id, job);
  const targetUrl = job.comfyUrl || comfyUrl;
  const history = await comfyJson('/history/' + encodeURIComponent(id), undefined, undefined, targetUrl);
  const record = history[id];
  if (record) {
    const outputs = Object.values(record.outputs || {}).flatMap(output => output.images || []).filter(image => image.type === 'output');
    const failure = (record.status?.messages || []).find(([type]) => type === 'execution_error' || type === 'execution_interrupted');
    if (failure || record.status?.status_str === 'error') {
      job.status = 'error';
      job.error = friendlyError(failure?.[1]?.exception_message || '任务在 ComfyUI 中执行失败，请查看其控制台。');
    } else if (outputs.length) {
      await archiveImages(id, outputs, targetUrl);
      job.status = 'completed';
      job.images = outputs;
    } else if (record.status?.completed) {
      job.status = 'error';
      job.error = '任务已结束但没有输出图片，请在 ComfyUI 中检查该任务。';
    }
    if (job.status === 'completed' || job.status === 'error') await saveState();
  }
  if (job.status !== 'completed' && job.status !== 'error') {
    const queue = await comfyJson('/queue', undefined, undefined, targetUrl);
    if ((queue.queue_running || []).some(item => item[1] === id)) job.status = 'running';
    else {
      const index = (queue.queue_pending || []).findIndex(item => item[1] === id);
      if (index >= 0) { job.status = 'queued'; job.queuePosition = index; }
      else if (Date.now() - job.createdAt > 30000) {
        // Check history once more: a job can finish between the first history and queue reads.
        const latest = await comfyJson('/history/' + encodeURIComponent(id), undefined, undefined, targetUrl);
        if (latest[id]) return inspectJobImpl(id);
        job.status = 'error';
        job.error = '任务已从 ComfyUI 队列移除，或服务曾重启，请重新生成。';
        await saveState();
      }
    }
  }
  return jobResponse(id, job);
}

function jobResponse(id, job) {
  const live = execution.get(id);
  return { promptId: id, status: job.status, seed: job.seed, progress: job.status === 'running' ? live?.progress || null : null, queuePosition: job.status === 'queued' ? job.queuePosition ?? 0 : 0, images: (job.images || []).map((image, index) => ({ filename: image.localFilename || image.filename, ...(image.localFilename ? { savedTo: `output/${image.localFilename}` } : {}), url: `/api/result/${encodeURIComponent(id)}/${index}` })), ...(job.error ? { error: job.error } : {}) };
}

let archiveTimer;
async function monitorJobs() {
  for (const [id, job] of jobs) {
    if (stopped) return;
    if (job.status === 'completed' || job.status === 'error') continue;
    try { await inspectJob(id); }
    catch (error) { console.warn(`Task ${id}: ${error.message}`); }
  }
  if (!stopped) archiveTimer = setTimeout(monitorJobs, 2000);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  let submitting = false;
  let changing = false;
  try {
    if (![`${'127.0.0.1'}:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new ApiError(403, '仅允许从本机访问');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new ApiError(403, '请从本机画廊页面使用生成功能');
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return;
    }
    const url = new URL(req.url, baseUrl);
    if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { projectRoot: root, pid: process.pid, edition: 'local' }); return; }
    if (req.method === 'GET' && url.pathname === '/api/idle') {
      requireIdleEngine();
      try { engine.checkIdle(); } catch (error) { throw new ApiError(409, error.message); }
      json(res, 200, { idle: true }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') { await readJson(req); requireIdleEngine(); json(res, 200, { stopping: true }); setTimeout(shutdown, 100); return; }
    if (req.method === 'GET' && url.pathname === '/api/local-engine') {
      json(res, 200, { engine: await engine.snapshot(), ...await engine.models() }); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/local-engine/')) {
      try {
        const action = url.pathname.slice('/api/local-engine/'.length);
        if (!action.startsWith('import-file/') && !req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '请使用 JSON 格式提交设置');
        if (action === 'detect') { const body = await readJson(req); json(res, 200, await detectExistingComfy(root, body.directory || '')); return; }
        const configuration = action === 'configure' ? await readJson(req) : null;
        if (['configure', 'start', 'stop'].includes(action)) { requireIdleEngine(); changing = true; changingEngine = true; }
        if (action === 'configure') { const settings = await engine.configure(configuration); resetConnection(); json(res, 200, settings); return; }
        if (action === 'start') { const settings = await engine.start(); resetConnection(); json(res, 200, settings); return; }
        if (action === 'stop') { const settings = await engine.stop(); resetConnection(); json(res, 200, settings); return; }
        if (action === 'download') { const body = await readJson(req); json(res, 202, engine.download(body.modelId, false, body.source)); return; }
        if (action === 'download-all') { const body = await readJson(req); json(res, 202, engine.downloadAll(body.source)); return; }
        if (action === 'detect-models') { await readJson(req); json(res, 202, engine.detectModels()); return; }
        if (action === 'import-path') { const body = await readJson(req); json(res, 202, engine.importPath(body.modelId, body.source)); return; }
        if (action === 'cancel') { json(res, 200, engine.cancel()); return; }
        if (action === 'reset-download') { json(res, 200, await engine.reset((await readJson(req)).modelId)); return; }
        if (action.startsWith('import-file/')) {
          const modelId = action.slice('import-file/'.length);
          const model = engine.model(modelId);
          const length = Number(req.headers['content-length']);
          if (!Number.isSafeInteger(length) || length !== model.bytes) throw new ApiError(400, '文件大小与所选模型不匹配');
          json(res, 200, await engine.importStream(modelId, req)); return;
        }
        throw new ApiError(404, '接口不存在');
      } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error.message); }
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      try {
        if (changingEngine) throw new ApiError(409, '连接设置正在切换，请稍后重新检查');
        const targetUrl = comfyUrl;
        const [{ model, missing }, queue] = await Promise.all([getModels(url.searchParams.has('refresh'), targetUrl), comfyJson('/queue', undefined, undefined, targetUrl)]);
        if (targetUrl !== comfyUrl || changingEngine) throw new ApiError(409, '连接设置已变化，请重新检查');
        engine.connected();
        json(res, 200, { connected: true, ready: !missing.length, message: missing.length ? missing.join('；') : 'Qwen-Image 2.1 标准版已就绪', comfyUrl, model, missing, features: { costumes: true, maxReferences: 2, projectOutput: true, loras: true }, outputDirectory: outputRoot, queue: { running: queue.queue_running?.length || 0, pending: queue.queue_pending?.length || 0 } });
      } catch (error) { json(res, 200, { connected: false, ready: false, message: error.message, comfyUrl, model: {}, missing: [], queue: { running: 0, pending: 0 } }); }
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/loras') {
      const targetUrl = comfyUrl;
      const { loras } = await getModels(url.searchParams.has('refresh'), targetUrl);
      if (targetUrl !== comfyUrl || changingEngine) throw new ApiError(409, '连接设置已变化，请刷新 LoRA 列表');
      json(res, 200, loras); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/reference') {
      if (changingEngine) throw new ApiError(409, '正在切换连接，请稍后上传');
      submitting = true; activeSubmissions++;
      const bytes = await readBody(req, 20 * 1048576);
      const type = imageType(bytes);
      if (!type) throw new ApiError(415, '请选择有效的 PNG、JPEG 或 WebP 图片');
      const id = randomUUID();
      const image = await uploadImage(bytes, `reference-${id}.${type.ext}`, 'pose_gallery/references');
      references.set(id, { image, comfyUrl, createdAt: Date.now() });
      await saveState();
      json(res, 201, { referenceId: id }); return;
    }
    if (req.method === 'POST' && ['/api/generate', '/api/prompt-preview'].includes(url.pathname)) {
      if (url.pathname === '/api/generate') {
        if (changingEngine) throw new ApiError(409, '正在切换连接，请稍后生成');
        submitting = true; activeSubmissions++;
      }
      let options;
      try { options = validateOptions(await readJson(req), poses, descriptions, costumes); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error.message); }
      const promptRecord = createPromptRecord(options);
      // Preview only compiles the same local template. It neither uploads images
      // nor contacts ComfyUI, and does not require live reference IDs.
      if (url.pathname === '/api/prompt-preview') { json(res, 200, promptRecord); return; }
      const personReferences = options.referenceIds.map(id => references.get(id));
      if (personReferences.some(reference => !reference)) throw new ApiError(400, '参考图记录已失效，请重新上传');
      if (personReferences.some(reference => reference.comfyUrl && reference.comfyUrl !== comfyUrl)) throw new ApiError(400, '参考图属于之前的 ComfyUI 连接，请重新上传');
      const { model, missing, loras } = await getModels(options.loras.length > 0);
      if (missing.length) throw new ApiError(503, missing.join('；'));
      const activeLoras = options.loras.filter(item => item.strength !== 0);
      if (activeLoras.length && !loras.available) throw new ApiError(400, '本机 ComfyUI 缺少 LoRA 模型加载节点，请将 LoRA 数量设为 0，或检查 ComfyUI 配置');
      for (const item of activeLoras) {
        if (!loras.names.includes(item.name)) throw new ApiError(400, `找不到 LoRA：${item.name}。请刷新列表后重新选择。`);
      }
      const poseImage = options.pose ? await uploadPose(options.pose) : null;
      const costumeImage = options.costume ? await uploadCostume(options.costume) : null;
      const graph = buildWorkflow({ options, model, poseImage, costumeImage, referenceImages: personReferences.map(reference => reference.image) });
      const metadata = { poseId: options.pose?.id || null, costumeId: options.costume?.id || null, referenceMode: options.referenceMode, referenceRoles: options.referenceRoles, referenceCount: personReferences.length, loras: options.loras, model: 'Qwen-Image 2.1 standard', seed: options.seed, promptRecord, comfyUrl };
      const result = await comfyJson('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: clientId, extra_data: { extra_pnginfo: { pose_gallery: metadata } } }) }, 30000);
      const id = result.prompt_id;
      if (typeof id !== 'string' || !/^[a-f\d-]+$/i.test(id)) throw new ApiError(502, 'ComfyUI 没有返回有效的任务编号');
      jobs.set(id, { ...metadata, status: 'queued', createdAt: Date.now(), images: [] });
      await saveState();
      json(res, 201, { promptId: id, seed: options.seed, promptRecord }); return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f\d-]+)$/i);
    if (req.method === 'GET' && jobMatch) { json(res, 200, await inspectJob(jobMatch[1])); return; }
    const resultMatch = url.pathname.match(/^\/api\/result\/([a-f\d-]+)\/(\d+)$/i);
    if (req.method === 'GET' && resultMatch) {
      const job = jobs.get(resultMatch[1]);
      const image = job?.images?.[Number(resultMatch[2])];
      if (!image || job.status !== 'completed') throw new ApiError(404, '结果图片不存在或仍在生成');
      if (!image.localFilename) {
        await archiveImages(resultMatch[1], job.images, job.comfyUrl || comfyUrl);
        await saveState();
      }
      if (path.basename(image.localFilename) !== image.localFilename) throw new ApiError(400, '结果图片路径不正确');
      const bytes = await readFile(path.join(outputRoot, image.localFilename)).catch(() => { throw new ApiError(404, '项目 output 文件夹中的图片已被移动或删除'); });
      res.setHeader('Content-Type', MIME[path.extname(image.localFilename)] || 'image/png');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${image.localFilename.replace(/[^a-z\d_.-]/gi, '_')}"`);
      res.writeHead(200); res.end(bytes); return;
    }
    if (url.pathname.startsWith('/api/')) throw new ApiError(404, '接口不存在');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, '不支持此请求方式');
    let relative;
    try { relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    catch { throw new ApiError(400, '文件路径格式不正确'); }
    if (relative.split(/[\\/]/).includes('..')) throw new ApiError(403, '文件路径不允许访问');
    if (!/^\/(?:index\.html|og-cover\.jpg|robots\.txt|sitemap\.xml|(?:assets|data|thumbs|img)\/[a-z\d_./-]+|costume\/(?:thumbs|img|png)\/[a-z\d_.-]+)$/i.test(relative)) throw new ApiError(404, '文件不存在');
    const filename = path.resolve(root, '.' + relative);
    if (!filename.startsWith(root + path.sep)) throw new ApiError(403, '文件路径不允许访问');
    const fileStat = await stat(filename).catch(() => { throw new ApiError(404, '文件不存在'); });
    if (!fileStat.isFile()) throw new ApiError(404, '文件不存在');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': fileStat.size, 'Cache-Control': /\/(?:img|thumbs)\//.test(relative) ? 'public, max-age=86400' : 'no-cache' });
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '本地服务处理失败，请查看启动窗口中的日志。' });
    else res.end();
    if (!error.status) console.error(error);
  } finally { if (submitting) activeSubmissions--; if (changing) changingEngine = false; }
});

// Multi-gigabyte browser model imports can legitimately take longer than the
// Node default body deadline; their size is bounded by the model catalog.
server.requestTimeout = 0;
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用。若画廊已启动，请打开 ${baseUrl}；否则用 GALLERY_PORT 指定其他端口。`);
  else console.error(error);
  process.exitCode = 1;
  stopped = true; clearTimeout(reconnectTimer); clearTimeout(archiveTimer); socket?.close();
});
server.listen(port, '127.0.0.1', () => console.log(`POSE Atlas: ${baseUrl}\nComfyUI: ${comfyUrl}\nModel: Qwen-Image 2.1 standard (no Turbo/Lightning)\nPress Ctrl+C to stop.`));
if (engine.settings.mode === 'builtin' && process.env.GALLERY_NO_AUTO_START !== '1') engine.start().then(resetConnection).catch(error => console.warn(error.message));
monitorJobs();
async function shutdown() { stopped = true; clearTimeout(reconnectTimer); clearTimeout(archiveTimer); socket?.close(); await engine.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
