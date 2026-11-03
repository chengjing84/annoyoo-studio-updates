import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { validateOptions, referencePlan } from './qwen-workflow.mjs';
import { createApiPromptRecord } from './api-prompt.mjs';
import { submitMediaTask, queryMediaTask } from './media-api.mjs';
import { ImageApiSettings, ImageApiError as ApiError, imageType, generateImage, resultBytes, safeProviderMessage } from './image-api.mjs';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.GALLERY_ROOT || path.join(scriptRoot, '..'));
const port = Number(process.env.GALLERY_PORT || 8765);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('GALLERY_PORT 不正确');
const baseUrl = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([baseUrl, `http://localhost:${port}`, 'null']);
const configuration = await ImageApiSettings.create(root);
const poses = new Map(JSON.parse(await readFile(path.join(root, 'data', 'pose-zh.json'), 'utf8')).map(item => [item.id, item]));
const costumes = new Map(JSON.parse(await readFile(path.join(root, 'data', 'costume-zh.json'), 'utf8')).map(item => [item.id, item]));
let descriptions = new Map();
try { descriptions = new Map(Object.entries(JSON.parse(await readFile(path.join(root, 'data', 'pose-descriptions.json'), 'utf8')).items || {})); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtimeRoot = path.join(root, '.local');
const referenceRoot = path.join(runtimeRoot, 'references');
const outputRoot = path.join(root, 'output');
await Promise.all([mkdir(referenceRoot, { recursive: true }), mkdir(outputRoot, { recursive: true })]);
const statePath = path.join(runtimeRoot, 'api-generation-state.json');
let saved = {};
try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') console.warn('旧 API 任务记录无法读取，将新建记录。'); }
const references = new Map(Object.entries(saved.references || {}));
const jobs = new Map(Object.entries(saved.jobs || {}));
for (const job of jobs.values()) {
  if (job.providerTask && !['completed', 'error', 'saving'].includes(job.status)) { job.status = 'polling'; job.lastPollAt = 0; continue; }
  if (!['completed', 'error', 'saving'].includes(job.status)) {
    job.status = 'error';
    job.error = '上次本地服务在生图请求结束前关闭。服务商可能已执行任务，请先查看服务商记录，再决定是否重新提交，避免重复计费。';
  }
}
let writing = Promise.resolve();
function saveState() {
  writing = writing.catch(() => {}).then(async () => {
    await writeFile(statePath + '.tmp', JSON.stringify({ references: Object.fromEntries(references), jobs: Object.fromEntries(jobs) }), 'utf8');
    await rename(statePath + '.tmp', statePath);
  });
  return writing;
}
await saveState();
let activeSubmissions = 0;
let changingSettings = false;
let stopped = false;
const terminal = job => ['completed', 'error'].includes(job.status);
function requireIdle() {
  if (changingSettings || activeSubmissions || [...jobs.values()].some(job => !terminal(job))) throw new ApiError(409, '存在上传或未完成的生图任务，请等待结束后再修改设置或停止创作台');
}

async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, `上传内容过大，请控制在 ${Math.round(limit / 1048576)} MB 以内`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '请使用 JSON 格式提交');
  try { return JSON.parse((await readBody(req, 65536)).toString('utf8')); }
  catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, '请求数据格式不正确'); }
}
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function promptRecordFor(options) {
  return createApiPromptRecord(options);
}
async function sourceImage(relative, expectedRoot) {
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(path.join(root, expectedRoot) + path.sep)) throw new ApiError(400, '参考图路径不正确');
  return { bytes: await readFile(filename) };
}
async function prepareImages(options) {
  const userImages = await Promise.all(options.referenceIds.map(async id => {
    const reference = references.get(id);
    if (!reference || typeof reference.filename !== 'string' || path.basename(reference.filename) !== reference.filename) throw new ApiError(400, '参考图记录已失效，请重新上传');
    try { return { bytes: await readFile(path.join(referenceRoot, reference.filename)) }; }
    catch { throw new ApiError(400, '参考图文件已被移动或删除，请重新上传'); }
  }));
  const poseImage = options.pose ? await sourceImage(options.pose.原图, 'img') : null;
  const costumeImage = options.costume ? await sourceImage(options.costume.原图, path.join('costume', 'png')) : null;
  return referencePlan(options).map(slot => slot.role === 'pose' ? poseImage : slot.role === 'costume' ? costumeImage : userImages[slot.index]);
}
function jobResponse(id, job) {
  return { promptId: id, status: ['saving', 'polling'].includes(job.status) ? 'running' : job.status, seed: null, progress: job.progress || null, queuePosition: 0, ...(job.providerTask ? { providerTaskId: job.providerTask.id, retryQuery: job.status === 'error' && !job.pendingImages && !job.providerFailed } : {}), images: (job.images || []).map((image, index) => ({ filename: image.localFilename, savedTo: `output/${image.localFilename}`, url: `/api/result/${id}/${index}` })), ...(job.error ? { error: job.error } : {}) };
}
const saving = new Set();
async function archiveJob(id) {
  const job = jobs.get(id);
  if (!job?.pendingImages || saving.has(id)) return;
  saving.add(id);
  try {
    for (const [index, image] of job.pendingImages.entries()) {
      if (job.images[index]) continue;
      const bytes = await resultBytes(image);
      const filename = `${id}-${index + 1}.${imageType(bytes).ext}`;
      await writeFile(path.join(outputRoot, filename + '.tmp'), bytes);
      await rename(path.join(outputRoot, filename + '.tmp'), path.join(outputRoot, filename));
      job.images[index] = { localFilename: filename };
      await saveState();
    }
    job.status = 'completed'; job.finishedAt = Date.now(); delete job.pendingImages; delete job.error; delete job.saveAttempts;
  } catch (error) {
    job.saveAttempts = (job.saveAttempts || 0) + 1;
    job.error = error.status ? error.message : '图片已生成，但保存到 output 失败。请检查磁盘空间和文件夹写入权限，勿重复生图。';
    if (job.saveAttempts >= 3) {
      job.status = 'error';
      job.error += ' 可点击“重试保存图片”重新下载，或到服务商获取结果。';
    }
  } finally { saving.delete(id); await saveState(); }
}
async function executeJob(id, settings, options, images, promptRecord) {
  const job = jobs.get(id);
  try {
    job.status = 'running'; await saveState();
    if (settings.protocol === 'lk-media') {
      job.providerTask = await submitMediaTask(settings, { prompt: promptRecord.rewritten_prompt, images, width: options.width, height: options.height });
      job.status = 'polling'; job.queryDeadline = Date.now() + 7200000;
      await saveState(); await pollProviderJob(id); return;
    }
    const results = await generateImage(settings, { prompt: promptRecord.rewritten_prompt, images, width: options.width, height: options.height });
    // A provider must not make its secret API key part of an output download URL.
    if (results.some(result => result.url && [settings.apiKey, encodeURIComponent(settings.apiKey)].some(key => key && result.url.includes(key)))) throw new ApiError(502, '接口把 API Key 包含在图片地址中，已停止保存；请在服务商后台获取结果并检查接口配置。');
    job.pendingImages = results; job.status = 'saving'; await saveState();
    await archiveJob(id);
  } catch (error) {
    job.status = 'error'; job.finishedAt = Date.now(); job.error = error.status ? safeProviderMessage(error.message, settings.apiKey) : '本地服务处理结果失败，请检查磁盘空间和运行日志。服务商可能已执行请求，请勿立即重复提交。';
    await saveState();
  }
}
const polling = new Set();
async function pollProviderJob(id) {
  const job = jobs.get(id);
  if (!job?.providerTask || job.status !== 'polling' || polling.has(id)) return;
  polling.add(id); job.lastPollAt = Date.now();
  const settings = { ...configuration.settings };
  try {
    if (settings.model !== job.model) throw new ApiError(409, '模型配置与提交时不同，请恢复原配置后重新查询');
    const result = await queryMediaTask(settings, job.providerTask);
    job.progress = result.progress; delete job.error;
    if (result.status === 'completed') {
      if (result.images.some(image => [settings.apiKey, encodeURIComponent(settings.apiKey)].some(key => key && image.url.includes(key)))) throw new ApiError(400, '结果地址包含 API Key，请到服务商后台取回图片');
      job.pendingImages = result.images; job.status = 'saving';
      await saveState(); await archiveJob(id);
    } else if (result.status === 'error') { job.status = 'error'; job.error = result.error; job.providerFailed = true; job.finishedAt = Date.now(); }
  } catch (error) {
    // Keep the original task ID after connection failures; never resubmit it.
    job.error = safeProviderMessage(error.message, settings.apiKey);
    if ([400, 401, 403, 409].includes(error.status)) job.status = 'error';
  } finally {
    if (job.status === 'polling' && Date.now() >= (job.queryDeadline || job.createdAt + 7200000)) {
      job.status = 'error'; job.error = '已查询原任务超过两小时。可点击“重新查询生成结果”继续取回原任务，无需重新生图。';
    }
    polling.delete(id); await saveState();
  }
}
let archiveTimer;
async function monitorArchives() {
  if (stopped) return;
  for (const [id, job] of jobs) {
    if (job.status === 'saving') await archiveJob(id);
    if (job.status === 'polling' && Date.now() - (job.lastPollAt || 0) >= 5000) await pollProviderJob(id);
  }
  if (!stopped) archiveTimer = setTimeout(monitorArchives, 3000);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  let submitting = false; let changing = false;
  try {
    if (![`${'127.0.0.1'}:${port}`, `localhost:${port}`].includes(req.headers.host)) throw new ApiError(403, '仅允许从本机访问');
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) throw new ApiError(403, '请从本机创作台页面使用此功能');
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }
    const url = new URL(req.url, baseUrl);
    if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { projectRoot: root, pid: process.pid, edition: 'api' }); return; }
    if (req.method === 'GET' && url.pathname === '/api/idle') { requireIdle(); json(res, 200, { idle: true }); return; }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') { await readJson(req); requireIdle(); json(res, 200, { stopping: true }); setTimeout(shutdown, 100); return; }
    if (req.method === 'GET' && url.pathname === '/api/image-api/configure') { json(res, 200, configuration.public()); return; }
    if (req.method === 'POST' && url.pathname === '/api/image-api/configure') {
      requireIdle(); changing = true; changingSettings = true;
      const result = await configuration.configure(await readJson(req)); json(res, 200, result); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const settings = configuration.public();
      json(res, 200, { edition: 'api', connected: settings.ready, ready: settings.ready, configured: settings.ready, verified: false, message: settings.ready ? `API 配置已保存 · ${settings.model}（生成时验证接口）` : settings.configurationError || '请打开 API 设置，填写接口地址、API Key 和模型名称', endpoint: settings.endpoint, sizeMode: settings.sizeMode, model: { name: settings.model }, missing: [], features: { costumes: true, maxReferences: 2, projectOutput: true, loras: false, steps: false, seed: false }, outputDirectory: outputRoot, queue: { running: [...jobs.values()].filter(job => !terminal(job)).length, pending: 0 } }); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/loras') { json(res, 200, { available: false, names: [], maxCount: 0 }); return; }
    if (req.method === 'POST' && url.pathname === '/api/reference') {
      submitting = true; activeSubmissions++;
      const bytes = await readBody(req, 20 * 1048576); const type = imageType(bytes);
      if (!type) throw new ApiError(415, '请选择有效的 PNG、JPEG 或 WebP 图片');
      const id = randomUUID(); const filename = `${id}.${type.ext}`;
      await writeFile(path.join(referenceRoot, filename), bytes);
      references.set(id, { filename, createdAt: Date.now() }); await saveState();
      json(res, 201, { referenceId: id }); return;
    }
    if (req.method === 'POST' && ['/api/generate', '/api/prompt-preview'].includes(url.pathname)) {
      const generate = url.pathname === '/api/generate';
      if (generate) { requireIdle(); submitting = true; activeSubmissions++; }
      let options;
      try { options = validateOptions(await readJson(req), poses, descriptions, costumes); }
      catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error.message); }
      const promptRecord = promptRecordFor(options);
      if (!generate) { json(res, 200, promptRecord); return; }
      if (!configuration.public().ready) throw new ApiError(400, '请先填写接口地址、API Key 和模型名称');
      if (options.loras.some(item => item.strength !== 0)) throw new ApiError(400, 'API 版不传本地 LoRA，请在服务商模型配置中设置');
      const settings = { ...configuration.settings };
      const images = await prepareImages(options);
      if (settings.protocol === 'qwen-json' && images.some(image => image.bytes.length > 10 * 1048576)) throw new ApiError(400, 'Qwen 接口每张参考图不能超过 10 MB，请压缩后重试');
      if (settings.protocol === 'lk-media' && (images.some(image => image.bytes.length > 10 * 1048576) || images.reduce((total, image) => total + image.bytes.length, 0) > 30 * 1048576)) throw new ApiError(400, 'LK 异步接口每张参考图最多 10 MB，合计最多 30 MB，请压缩后重试');
      const id = randomUUID();
      jobs.set(id, { status: 'queued', createdAt: Date.now(), images: [], model: settings.model, protocol: settings.protocol, poseId: options.pose?.id || null, costumeId: options.costume?.id || null, referenceMode: options.referenceMode, referenceRoles: options.referenceRoles, referenceCount: options.referenceIds.length, promptRecord });
      await saveState();
      json(res, 201, { promptId: id, seed: null, promptRecord });
      setImmediate(() => executeJob(id, settings, options, images, promptRecord)); return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f\d-]+)$/i);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]); if (!job) throw new ApiError(404, '未找到这条生成记录');
      if (job.status === 'error' && job.pendingImages && url.searchParams.get('retry-save') === '1') {
        requireIdle(); job.status = 'saving'; job.saveAttempts = 0; delete job.error; await saveState();
        setImmediate(() => archiveJob(jobMatch[1]));
      }
      if (job.status === 'error' && job.providerTask && !job.pendingImages && !job.providerFailed && url.searchParams.get('retry-query') === '1') {
        requireIdle(); job.status = 'polling'; job.queryDeadline = Date.now() + 7200000; delete job.error; await saveState();
        setImmediate(() => pollProviderJob(jobMatch[1]));
      }
      json(res, 200, { ...jobResponse(jobMatch[1], job), retrySave: !!job.pendingImages && job.status === 'error' }); return;
    }
    const resultMatch = url.pathname.match(/^\/api\/result\/([a-f\d-]+)\/(\d+)$/i);
    if (req.method === 'GET' && resultMatch) {
      const job = jobs.get(resultMatch[1]); const image = job?.images?.[Number(resultMatch[2])];
      if (!image || job.status !== 'completed' || path.basename(image.localFilename) !== image.localFilename) throw new ApiError(404, '结果图片不存在或仍在生成');
      const bytes = await readFile(path.join(outputRoot, image.localFilename)).catch(() => { throw new ApiError(404, 'output 中的图片已被移动或删除'); });
      res.setHeader('Content-Type', MIME[path.extname(image.localFilename)] || 'image/png'); res.setHeader('Cache-Control', 'private, max-age=3600');
      if (url.searchParams.has('download')) res.setHeader('Content-Disposition', `attachment; filename="${image.localFilename}"`);
      res.writeHead(200); res.end(bytes); return;
    }
    if (url.pathname.startsWith('/api/')) throw new ApiError(404, '接口不存在');
    if (!['GET', 'HEAD'].includes(req.method)) throw new ApiError(405, '不支持此请求方式');
    let relative;
    try { relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch { throw new ApiError(400, '文件路径格式不正确'); }
    if (relative.split(/[\\/]/).includes('..')) throw new ApiError(403, '文件路径不允许访问');
    if (!/^\/(?:index\.html|og-cover\.jpg|robots\.txt|sitemap\.xml|(?:assets|data|thumbs|img)\/[a-z\d_./-]+|costume\/(?:thumbs|img|png)\/[a-z\d_.-]+)$/i.test(relative)) throw new ApiError(404, '文件不存在');
    const filename = path.resolve(root, '.' + relative);
    if (!filename.startsWith(root + path.sep)) throw new ApiError(403, '文件路径不允许访问');
    const info = await stat(filename).catch(() => { throw new ApiError(404, '文件不存在'); });
    if (!info.isFile()) throw new ApiError(404, '文件不存在');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filename)] || 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': /\/(?:img|thumbs)\//.test(relative) ? 'public, max-age=86400' : 'no-cache' });
    if (req.method === 'HEAD') res.end(); else createReadStream(filename).pipe(res);
  } catch (error) {
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? safeProviderMessage(error.message, configuration.settings.apiKey) : '本地服务处理失败，请检查磁盘空间和运行日志' });
    else res.end();
    if (!error.status) console.error('API edition local processing error:', error.code || error.name || 'unknown');
  } finally { if (submitting) activeSubmissions--; if (changing) changingSettings = false; }
});
server.requestTimeout = 120000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用` : 'API 创作台启动失败'); stopped = true; clearTimeout(archiveTimer); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`POSE Atlas API: ${baseUrl}\nOutput: ${outputRoot}\nPress Ctrl+C to stop.`));
monitorArchives();
async function shutdown() { if (stopped) return; stopped = true; clearTimeout(archiveTimer); await writing.catch(() => {}); server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
