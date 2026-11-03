import { readFile, writeFile, mkdir, rename, stat, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn, fork } from 'node:child_process';
import { createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const catalogPath = fileURLToPath(new URL('../config/model-catalog.json', import.meta.url));
const exists = async file => !!(await stat(file).catch(() => null));
const DOWNLOAD_SOURCES = [
  { id: 'mirror', name: '国内镜像 · HF-Mirror' },
  { id: 'official', name: 'Hugging Face 官方' }
];
export function modelDownloadSource(model, sourceId = 'official') {
  const source = DOWNLOAD_SOURCES.find(item => item.id === sourceId);
  if (!source) throw new Error('请选择国内镜像或官方直连');
  const url = new URL(model.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型下载地址无效');
  if (sourceId === 'mirror') {
    if (url.hostname !== 'huggingface.co' || url.protocol !== 'https:') throw new Error('此模型未配置国内镜像，请选择官方直连');
    url.hostname = 'hf-mirror.com';
  }
  return { ...source, url: url.href, direct: sourceId === 'mirror' };
}
export function normalizeComfyUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('请输入完整的 ComfyUI 地址，例如 http://127.0.0.1:8188'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('ComfyUI 地址仅支持不含账号、查询参数的 HTTP / HTTPS 地址');
  if (['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('请填写实际访问地址，本机请用 127.0.0.1');
  return url.href.replace(/\/$/, '');
}

const isFile = async file => (await stat(file).catch(() => null))?.isFile() || false;
function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value.trim())) throw new Error(`${label}必须是本机完整路径`);
  if (value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error(`${label}格式不正确`);
  return path.resolve(value.trim());
}

// Inspect a selected installation and a short list of portable/venv layouts.
// This never recursively scans drives or changes the selected installation.
export async function inspectExistingComfy(directory, pythonExecutable = '') {
  const selected = absoluteDirectory(directory, 'ComfyUI 目录');
  const core = await isFile(path.join(selected, 'main.py')) ? selected
    : await isFile(path.join(selected, 'ComfyUI', 'main.py')) ? path.join(selected, 'ComfyUI') : null;
  if (!core) throw new Error('所选目录中未找到 ComfyUI 的 main.py，可选择 ComfyUI 目录或它的整合包目录');
  let python = '';
  if (pythonExecutable) {
    python = absoluteDirectory(pythonExecutable, 'Python 可执行文件');
    if (!await isFile(python)) throw new Error('未找到所选 Python 可执行文件，请检查完整路径');
  } else {
    const bases = [...new Set([selected, path.dirname(core), core])];
    const candidates = bases.flatMap(base => [
      path.join(base, 'python_embeded', 'python.exe'),
      path.join(base, 'python_embedded', 'python.exe'),
      path.join(base, 'python', 'python.exe'),
      path.join(base, '.venv', 'Scripts', 'python.exe'),
      path.join(base, 'venv', 'Scripts', 'python.exe'),
      path.join(base, '.venv', 'bin', 'python'),
      path.join(base, 'venv', 'bin', 'python')
    ]);
    for (const candidate of candidates) if (await isFile(candidate)) { python = candidate; break; }
  }
  return { comfyDirectory: core, pythonExecutable: python };
}

export async function detectExistingComfy(root, directory = '') {
  if (directory) return { candidates: [await inspectExistingComfy(directory)], urls: ['http://127.0.0.1:8188'] };
  const parent = path.dirname(path.resolve(root));
  const folders = [...new Set([
    path.join(parent, 'ComfyUI'), path.join(parent, 'ComfyUI_windows_portable'),
    path.join(parent, 'ComfyUI_windows_portable_nvidia'), path.join(root, 'ComfyUI')
  ])];
  const candidates = [];
  for (const folder of folders) {
    try {
      const candidate = await inspectExistingComfy(folder);
      if (!candidates.some(item => item.comfyDirectory.toLowerCase() === candidate.comfyDirectory.toLowerCase())) candidates.push(candidate);
    } catch {}
  }
  return { candidates, urls: ['http://127.0.0.1:8188'] };
}

export class LocalEngine {
  static async create(root, { initialUrl, catalog } = {}) {
    const engine = new LocalEngine(root);
    engine.catalog = catalog || JSON.parse(await readFile(catalogPath, 'utf8'));
    let settings = {};
    try { settings = JSON.parse(await readFile(engine.settingsFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    engine.settings = {
      mode: settings.mode || (initialUrl || await exists(path.join(root, '.local', 'generation-state.json')) ? 'external' : await engine.available() ? 'builtin' : 'external'),
      externalUrl: normalizeComfyUrl(settings.externalUrl || initialUrl || 'http://127.0.0.1:8188'),
      modelDirectories: Array.isArray(settings.modelDirectories) ? settings.modelDirectories : [],
      comfyDirectory: settings.comfyDirectory || '',
      pythonExecutable: settings.pythonExecutable || ''
    };
    return engine;
  }
  constructor(root) {
    this.root = root;
    this.local = path.join(root, '.local');
    this.settingsFile = path.join(this.local, 'local-settings.json');
    this.modelRoot = path.join(root, 'models');
    this.python = path.join(root, 'runtime', 'comfyui', 'python', 'python.exe');
    this.comfyRoot = path.join(root, 'runtime', 'comfyui', 'ComfyUI');
    this.builtinUrl = 'http://127.0.0.1:8189';
    this.child = null;
    this.ownedKind = null;
    this.externalProcessUrl = null;
    this.spawnProcess = spawn;
    this.phase = 'stopped';
    this.error = '';
    this.task = null;
    this.controller = null;
    this.starting = null;
    this.bulkQueue = [];
    this.bulkPending = null;
  }
  get url() { return this.settings.mode === 'builtin' ? this.builtinUrl : this.child && this.ownedKind === 'external' ? this.externalProcessUrl : this.settings.externalUrl; }
  async available() { return await exists(this.python) && await exists(path.join(this.comfyRoot, 'main.py')); }
  async snapshot() {
    return { ...this.settings, projectRoot: this.root, endpoint: this.url, builtinAvailable: await this.available(), phase: this.phase, error: this.error, owned: !!this.child, ownedKind: this.child ? this.ownedKind : null, modelRoot: this.modelRoot };
  }
  async configure(body) {
    if (!body || !['external', 'builtin'].includes(body.mode)) throw new Error('请选择内置或已有 ComfyUI');
    if (this.child && body.mode !== this.settings.mode) throw new Error('请先停止本程序启动的 ComfyUI，再切换连接方式');
    const directories = body.modelDirectories ?? this.settings.modelDirectories;
    if (!Array.isArray(directories) || directories.length > 8 || directories.some(item => typeof item !== 'string' || !path.isAbsolute(item))) throw new Error('额外模型目录必须是本机绝对路径，每行一个，最多 8 个');
    for (const directory of directories) if (!(await stat(directory).catch(() => null))?.isDirectory()) throw new Error(`模型目录不存在：${directory}`);
    if (this.child && JSON.stringify(directories) !== JSON.stringify(this.settings.modelDirectories)) throw new Error('修改模型目录前请先停止内置 ComfyUI');
    let comfyDirectory = body.comfyDirectory ?? this.settings.comfyDirectory ?? '';
    let pythonExecutable = body.pythonExecutable ?? (body.comfyDirectory !== undefined && body.comfyDirectory !== this.settings.comfyDirectory ? '' : this.settings.pythonExecutable ?? '');
    if (typeof comfyDirectory !== 'string' || typeof pythonExecutable !== 'string') throw new Error('ComfyUI 与 Python 路径格式不正确');
    if (body.mode === 'external' && comfyDirectory.trim()) {
      ({ comfyDirectory, pythonExecutable } = await inspectExistingComfy(comfyDirectory, pythonExecutable));
      if (!pythonExecutable) throw new Error('已找到 ComfyUI，请补充它使用的 Python 可执行文件完整路径');
    } else if (!comfyDirectory.trim()) {
      if (pythonExecutable.trim()) throw new Error('请先填写 Python 对应的 ComfyUI 目录');
      comfyDirectory = ''; pythonExecutable = '';
    }
    const next = { mode: body.mode, externalUrl: normalizeComfyUrl(body.externalUrl || this.settings.externalUrl), modelDirectories: directories, comfyDirectory, pythonExecutable };
    if (this.child && (next.comfyDirectory !== this.settings.comfyDirectory || next.pythonExecutable !== this.settings.pythonExecutable || next.externalUrl !== this.settings.externalUrl)) throw new Error('修改运行路径或地址前，请先停止本程序启动的 ComfyUI');
    await mkdir(this.local, { recursive: true });
    await writeFile(this.settingsFile + '.tmp', JSON.stringify(next, null, 2));
    await rename(this.settingsFile + '.tmp', this.settingsFile);
    this.settings = next;
    return this.snapshot();
  }
  async freePort() {
    for (let port = 8189; port < 8240; port++) {
      const available = await new Promise(resolve => {
        const server = createServer(); server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
      });
      if (available) return port;
    }
    throw new Error('没有可用的内置 ComfyUI 端口');
  }
  async start() {
    if (this.settings.mode !== 'builtin' && !this.settings.comfyDirectory) throw new Error('当前为连接已有 ComfyUI，请在原环境中启动它，或填写安装目录和 Python 路径');
    if (this.starting) return this.starting;
    if (this.child) return this.snapshot();
    this.starting = (this.settings.mode === 'builtin' ? this.startImpl() : this.startExistingImpl()).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startImpl() {
    if (!await this.available()) throw new Error('未找到随包的内置运行环境，请使用完整本地版，或连接已有 ComfyUI');
    const port = await this.freePort();
    this.builtinUrl = `http://127.0.0.1:${port}`;
    await mkdir(this.local, { recursive: true });
    await mkdir(this.modelRoot, { recursive: true });
    for (const item of this.catalog.models) await mkdir(path.dirname(this.model(item.id).target), { recursive: true });
    await mkdir(path.join(this.modelRoot, 'loras'), { recursive: true });
    await mkdir(path.join(this.local, 'comfy-user'), { recursive: true });
    await mkdir(path.join(this.local, 'comfy-output'), { recursive: true });
    await mkdir(path.join(this.local, 'comfy-input'), { recursive: true });
    await mkdir(path.join(this.local, 'comfy-temp'), { recursive: true });
    const roots = [this.modelRoot, ...this.settings.modelDirectories];
    const yaml = roots.map((directory, index) => `pose_atlas_${index}:\n  base_path: ${JSON.stringify(directory.replaceAll('\\', '/'))}\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n`).join('\n');
    const config = path.join(this.local, 'comfy-model-paths.yaml');
    await writeFile(config, yaml);
    const log = await open(path.join(this.local, 'comfyui.log'), 'a');
    const args = ['-I', '-B', path.join(this.comfyRoot, 'main.py'), '--listen', '127.0.0.1', '--port', String(port), '--disable-all-custom-nodes', '--offline', '--disable-comfy-compiler', '--extra-model-paths-config', config, '--output-directory', path.join(this.local, 'comfy-output'), '--input-directory', path.join(this.local, 'comfy-input'), '--temp-directory', path.join(this.local, 'comfy-temp'), '--user-directory', path.join(this.local, 'comfy-user')];
    this.phase = 'starting'; this.error = '';
    this.ownedKind = 'builtin';
    const child = this.spawnProcess(this.python, args, { cwd: this.comfyRoot, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    this.child = child;
    child.once('error', error => { this.error = error.message; this.phase = 'error'; this.child = null; this.ownedKind = null; });
    child.once('exit', code => { if (this.child === child) { this.child = null; this.ownedKind = null; this.phase = code ? 'error' : 'stopped'; if (code) this.error = `内置引擎退出（${code}），请查看 .local/comfyui.log`; } });
    await log.close();
    return this.snapshot();
  }
  async startExistingImpl() {
    const installation = await inspectExistingComfy(this.settings.comfyDirectory, this.settings.pythonExecutable);
    if (!installation.pythonExecutable) throw new Error('请填写已有 ComfyUI 对应的 Python 可执行文件');
    try {
      const response = await fetch(this.settings.externalUrl + '/system_stats', { signal: AbortSignal.timeout(2000) });
      const stats = response.ok ? await response.json() : null;
      if (stats?.system && Array.isArray(stats.devices)) {
        this.phase = 'running'; this.error = '';
        return this.snapshot();
      }
    } catch {}
    const port = await this.freePort();
    this.externalProcessUrl = `http://127.0.0.1:${port}`;
    for (const folder of ['', 'comfy-user', 'comfy-output', 'comfy-input', 'comfy-temp']) await mkdir(path.join(this.local, folder), { recursive: true });
    const args = ['-B', path.join(installation.comfyDirectory, 'main.py'), '--listen', '127.0.0.1', '--port', String(port), '--offline',
      '--output-directory', path.join(this.local, 'comfy-output'), '--input-directory', path.join(this.local, 'comfy-input'),
      '--temp-directory', path.join(this.local, 'comfy-temp'), '--user-directory', path.join(this.local, 'comfy-user')];
    if (this.settings.modelDirectories.length) {
      const yaml = this.settings.modelDirectories.map((directory, index) => `pose_atlas_${index}:\n  base_path: ${JSON.stringify(directory.replaceAll('\\', '/'))}\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n`).join('\n');
      const config = path.join(this.local, 'comfy-existing-model-paths.yaml');
      await writeFile(config, yaml); args.push('--extra-model-paths-config', config);
    }
    const log = await open(path.join(this.local, 'comfyui-existing.log'), 'a');
    this.phase = 'starting'; this.error = ''; this.ownedKind = 'external';
    const child = this.spawnProcess(installation.pythonExecutable, args, { cwd: installation.comfyDirectory, windowsHide: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    this.child = child;
    child.once('error', error => { if (this.child === child) { this.child = null; this.ownedKind = null; this.error = error.message; this.phase = 'error'; } });
    child.once('exit', code => { if (this.child === child) { this.child = null; this.ownedKind = null; this.phase = code ? 'error' : 'stopped'; if (code) this.error = `已有环境启动失败（${code}），请查看 .local/comfyui-existing.log`; } });
    await log.close();
    return this.snapshot();
  }
  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
    this.child = null; this.ownedKind = null; this.externalProcessUrl = null; this.phase = 'stopped'; this.error = '';
    return this.snapshot();
  }
  connected() { if (this.child) this.phase = 'running'; }
  model(id) {
    const model = this.catalog.models.find(item => item.id === id);
    if (!model) throw new Error('请选择有效的模型');
    const target = path.resolve(this.modelRoot, model.file);
    if (!target.startsWith(this.modelRoot + path.sep)) throw new Error('模型目标路径不正确');
    return { ...model, target };
  }
  async locateModel(model) {
    const paths = [model.target];
    for (const directory of this.settings.modelDirectories) {
      paths.push(path.join(directory, model.file), path.join(directory, model.file.split('/')[0], path.basename(model.file)));
    }
    let incomplete = null;
    for (const filename of [...new Set(paths)]) {
      const file = await stat(filename).catch(() => null);
      if (!file?.isFile()) continue;
      const result = { filename, file };
      if (file.size === model.bytes) return result;
      incomplete ||= result;
    }
    return incomplete;
  }
  modelProofPath(model, filename) {
    return filename === model.target ? filename + '.verified.json'
      : path.join(this.local, 'model-checks', createHash('sha256').update(path.resolve(filename)).digest('hex') + '.json');
  }
  async models() {
    const models = await Promise.all(this.catalog.models.map(async item => {
      const model = this.model(item.id);
      const located = await this.locateModel(model);
      const file = located?.file;
      const part = await stat(model.target + '.part').catch(() => null);
      let proof;
      try { proof = JSON.parse(await readFile(this.modelProofPath(model, located?.filename || model.target), 'utf8')); } catch {}
      return { ...item, location: located?.filename || model.target, wrongSize: !!file && file.size !== item.bytes, present: file?.size === item.bytes, verified: !!file && file.size === item.bytes && proof?.sha256 === item.sha256 && proof.size === file.size && proof.mtimeMs === file.mtimeMs, downloadedBytes: file?.size || part?.size || 0 };
    }));
    return { models, modelRoot: this.modelRoot, quarkUrl: this.catalog.quarkUrl || '', quarkCode: this.catalog.quarkCode || '', downloadSources: DOWNLOAD_SOURCES, defaultDownloadSource: this.catalog.defaultDownloadSource || 'official', task: this.task, queuedModelIds: [...this.bulkQueue] };
  }
  checkIdle(fromQueue = false) { if ((!fromQueue && this.bulkPending) || this.task && ['queued', 'downloading', 'retrying', 'importing', 'verifying'].includes(this.task.status)) throw new Error('模型任务正在进行，请等待完成或先取消'); }
  async verifyPresent(model) {
    this.task.status = 'verifying';
    this.task.received = 0; this.task.total = model.bytes;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(model.target)) { this.controller.signal.throwIfAborted(); hash.update(chunk); this.task.received += chunk.length; }
    const file = await stat(model.target);
    if (file.size !== model.bytes || hash.digest('hex') !== model.sha256) throw new Error('模型校验未通过，文件已保留；请重新下载并放回指定位置后检测');
    const proofPath = model.proofPath || model.target + '.verified.json';
    await mkdir(path.dirname(proofPath), { recursive: true });
    await writeFile(proofPath, JSON.stringify({ sha256: model.sha256, size: file.size, mtimeMs: file.mtimeMs }));
    this.task.received = model.bytes;
  }
  detectModels() {
    this.checkIdle();
    const first = this.catalog.models[0];
    if (!first) throw new Error('模型清单为空');
    return this.launch(this.model(first.id), async () => {
      this.task.kind = 'detection'; this.task.checked = 0; this.task.missingIds = [];
      this.task.totalModels = this.catalog.models.length;
      for (const item of this.catalog.models) {
        this.controller.signal.throwIfAborted();
        const model = this.model(item.id);
        this.task.modelId = model.id;
        const found = (await this.models()).models.find(entry => entry.id === model.id);
        if (!found.present) this.task.missingIds.push(model.id);
        else if (!found.verified) {
          try { await this.verifyPresent({ ...model, target: found.location, proofPath: this.modelProofPath(model, found.location) }); }
          catch (error) { if (!this.controller.signal.aborted) error.message = `${model.name}：${error.message}`; throw error; }
        }
        this.task.checked++;
      }
    });
  }
  async writeVerified(model) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(model.target + '.part')) {
      this.controller?.signal.throwIfAborted(); hash.update(chunk); bytes += chunk.length;
    }
    if (bytes !== model.bytes || hash.digest('hex') !== model.sha256) {
      const error = new Error(bytes < model.bytes ? '下载连接提前结束，已保留进度' : '模型大小或 SHA-256 校验不一致。临时文件已保留，可重新导入；下载请先重置此模型的临时文件');
      error.retryable = bytes < model.bytes;
      throw error;
    }
    await rename(model.target + '.part', model.target);
    const file = await stat(model.target);
    await writeFile(model.target + '.verified.json', JSON.stringify({ sha256: model.sha256, size: file.size, mtimeMs: file.mtimeMs }));
  }
  async transfer(model, input, { append = false, status = 'downloading', expected = model.bytes } = {}) {
    const initial = append ? (await stat(model.target + '.part').catch(() => null))?.size || 0 : 0;
    this.task.status = status; this.task.received = initial;
    const progress = new Transform({ transform: (chunk, encoding, callback) => {
      this.task.received += chunk.length;
      if (this.task.received > expected) callback(new Error('模型文件超过官方预期大小'));
      else callback(null, chunk);
    } });
    await pipeline(input, progress, createWriteStream(model.target + '.part', { flags: append ? 'a' : 'w' }), { signal: this.controller.signal });
    this.task.status = 'verifying';
    await this.writeVerified(model);
  }
  launch(model, run, fromQueue = false) {
    this.checkIdle(fromQueue);
    this.controller = new AbortController();
    this.task = { modelId: model.id, status: 'queued', received: 0, total: model.bytes, error: '', startedAt: Date.now() };
    this.pending = (async () => {
      try {
        await mkdir(path.dirname(model.target), { recursive: true });
        await run(); this.task.status = 'completed';
      } catch (error) {
        this.task.status = this.controller.signal.aborted ? 'cancelled' : 'error';
        this.task.error = this.controller.signal.aborted ? '任务已取消，下载进度已保留'
          : error.code === 'ENOSPC' ? '磁盘空间不足，请释放模型保存盘的空间后重试'
          : error.code === 'ENOENT' ? '找不到模型文件，请检查完整路径'
          : error.message === 'fetch failed' ? '无法连接官方下载源。可稍后继续下载，或改用手动导入'
          : error.message;
      }
    })();
    return { ...this.task };
  }
  download(id, fromQueue = false, sourceId = this.catalog.defaultDownloadSource || 'official') {
    const model = this.model(id);
    const source = modelDownloadSource(model, sourceId);
    return this.launch(model, async () => {
      const ready = (await this.models()).models.find(item => item.id === id);
      if (ready.verified) { this.task.received = model.bytes; return; }
      if (ready.present) { await this.verifyPresent({ ...model, target: ready.location, proofPath: this.modelProofPath(model, ready.location) }); return; }
      this.task.sourceId = source.id; this.task.sourceName = source.name; this.task.sourceHost = new URL(source.url).hostname;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.task.attempt = attempt;
        try { await this.downloadAttempt(model, source); return; }
        catch (error) {
          this.controller.signal.throwIfAborted();
          if (!error.retryable || attempt === 3) throw error;
          this.task.status = 'retrying';
          this.task.received = (await stat(model.target + '.part').catch(() => null))?.size || 0;
          await delay(attempt * 1000, undefined, { signal: this.controller.signal });
        }
      }
    }, fromQueue);
  }
  async downloadAttempt(model, source) {
      let offset = (await stat(model.target + '.part').catch(() => null))?.size || 0;
      if (offset === model.bytes) { this.task.status = 'verifying'; await this.writeVerified(model); return; }
      if (offset > model.bytes) throw new Error('临时下载文件过大，请重置后重新下载');
      this.controller.signal.throwIfAborted();
      const modernNode = Number(process.versions.node.split('.')[0]) >= 25;
      const environment = { ...process.env, NO_PROXY: source.direct ? '*' : [process.env.NO_PROXY || process.env.no_proxy || '', '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',') };
      if (source.direct) for (const key of Object.keys(environment)) if (/^(?:(?:http|https|all)_proxy|node_use_env_proxy)$/i.test(key)) delete environment[key];
      const worker = fork(fileURLToPath(new URL('./model-download-worker.mjs', import.meta.url)), [source.url, String(offset)], {
        execPath: process.execPath, execArgv: modernNode ? [...(source.direct ? [] : ['--use-env-proxy']), '--use-system-ca'] : [],
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
        env: environment
      });
      const cancel = () => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); };
      worker.stdout.on('error', () => {});
      this.controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        const response = await new Promise((resolve, reject) => {
          let headersReceived = false;
          worker.on('message', data => {
            if (data.error) { const error = Object.assign(new Error(data.error), { retryable: data.retryable }); if (headersReceived) worker.stdout.destroy(error); else reject(error); }
            else if (!headersReceived) { headersReceived = true; resolve(data); }
          });
          worker.once('error', reject);
          worker.once('exit', code => { if (!headersReceived) reject(Object.assign(new Error('模型下载进程已结束，请重试'), { retryable: true })); else if (code !== 0 && !worker.stdout.destroyed) worker.stdout.destroy(Object.assign(new Error('下载连接中断，进度已保留，可继续下载'), { retryable: true })); });
        });
        this.controller.signal.throwIfAborted();
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.contentRange || '');
          if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) >= model.bytes || Number(range[3]) !== model.bytes) throw new Error('下载服务器返回的断点范围不正确，临时进度未被覆盖');
        }
        if (response.status !== 206) offset = 0;
        await this.transfer(model, worker.stdout, { append: offset > 0 });
      } finally { this.controller.signal.removeEventListener('abort', cancel); cancel(); }
  }
  downloadAll(sourceId = this.catalog.defaultDownloadSource || 'official') {
    this.checkIdle();
    for (const model of this.catalog.models) modelDownloadSource(model, sourceId);
    this.bulkQueue = this.catalog.models.map(model => model.id);
    this.bulkPending = (async () => {
      while (this.bulkQueue.length) {
        this.download(this.bulkQueue.shift(), true, sourceId);
        await this.pending;
        if (this.task.status !== 'completed') break;
      }
    })().catch(error => { if (this.task) { this.task.status = 'error'; this.task.error = error.message; } }).finally(() => { this.bulkQueue = []; this.bulkPending = null; });
    return { queuedModelIds: [...this.bulkQueue], task: this.task };
  }
  importPath(id, source) {
    const model = this.model(id);
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('请输入模型文件的本机绝对路径');
    if (path.resolve(source) === model.target) return this.launch(model, () => this.verifyPresent(model));
    return this.launch(model, async () => {
      const file = await stat(source);
      if (!file.isFile() || file.size !== model.bytes) throw new Error('所选文件大小与该模型不匹配，请确认选择的是对应模型');
      await this.transfer(model, createReadStream(source), { status: 'importing' });
    });
  }
  async importStream(id, input) {
    const model = this.model(id);
    this.launch(model, () => this.transfer(model, input, { status: 'importing' }));
    await this.pending;
    if (this.task.status !== 'completed') throw new Error(this.task.error);
    return this.task;
  }
  cancel() { this.bulkQueue = []; this.controller?.abort(); return this.task; }
  async reset(id) {
    this.checkIdle(); const model = this.model(id);
    const { unlink } = await import('node:fs/promises');
    await unlink(model.target + '.part').catch(error => { if (error.code !== 'ENOENT') throw error; });
    return this.models();
  }
  async close() { this.cancel(); await this.bulkPending; await this.pending; await this.stop(); }
}
