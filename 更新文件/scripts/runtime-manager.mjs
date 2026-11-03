import { readFile, writeFile, mkdir, rename, stat, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { fork, spawn, execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const exists = async filename => !!(await stat(filename).catch(() => null));
const activeStatuses = new Set(['queued', 'downloading', 'importing', 'verifying', 'extracting', 'checking']);

export class RuntimeManager {
  static async create(root, { catalog, validateEnvironment = true } = {}) {
    const manager = new RuntimeManager(path.resolve(root));
    manager.catalog = catalog || JSON.parse(await readFile(path.join(here, '../config/runtime-catalog.json'), 'utf8'));
    try { manager.distribution = JSON.parse(await readFile(path.join(root, 'config/distribution.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('发行配置无法读取，请重新获取整合包'); }
    manager.validateEnvironment = validateEnvironment;
    const item = manager.catalog;
    if (!item || typeof item.packageId !== 'string' || typeof item.archiveName !== 'string' || path.basename(item.archiveName) !== item.archiveName || !/\.zip$/i.test(item.archiveName) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || !/^[a-f\d]{64}$/i.test(item.sha256)) throw new Error('运行环境清单不完整，请重新获取创作台安装包');
    if (item.downloadUrl) {
      const url = new URL(item.downloadUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('运行环境下载地址无效');
    }
    return manager;
  }
  constructor(root) {
    this.root = root;
    this.local = path.join(root, '.local');
    this.task = null;
    this.pending = null;
    this.controller = null;
    this.child = null;
  }
  get active() { return !!this.pending || activeStatuses.has(this.task?.status); }
  checkIdle() { if (this.active) throw new Error('运行环境任务尚未完成，请等待结束后再操作'); }
  async available() { return await exists(path.join(this.root, 'runtime/comfyui/python/python.exe')) && await exists(path.join(this.root, 'runtime/comfyui/ComfyUI/main.py')); }
  async snapshot() {
    let localArchive = '';
    for (const candidate of [path.join(this.root, this.catalog.archiveName), path.join(path.dirname(this.root), this.catalog.archiveName)]) {
      const file = await stat(candidate).catch(() => null);
      if (file?.isFile() && file.size === this.catalog.bytes) { localArchive = candidate; break; }
    }
    return { available: await this.available(), bundled: this.distribution?.mode === 'integrated', fullPackageUrl: this.distribution?.fullPackageUrl || '', runtimeRoot: path.join(this.root, 'runtime'), manualUrl: this.catalog.manualUrl || '', task: this.task ? { ...this.task } : null,
      downloadConfigured: !!this.catalog.downloadUrl, downloadUrl: this.catalog.downloadUrl || '', quarkUrl: this.catalog.quarkUrl || '', quarkCode: this.catalog.quarkCode || '',
      archiveName: this.catalog.archiveName, bytes: this.catalog.bytes, unpackedBytes: this.catalog.unpackedBytes,
      platform: this.catalog.platform, arch: this.catalog.arch, compatibility: this.catalog.compatibility,
      localArchive, python: this.catalog.python, torch: this.catalog.torch, comfyUI: this.catalog.comfyUI };
  }
  launch(action) {
    this.checkIdle();
    this.controller = new AbortController();
    this.task = { status: 'queued', received: 0, total: this.catalog.bytes, startedAt: Date.now() };
    const signal = this.controller.signal;
    this.pending = (async () => {
      try {
        if (await this.available()) throw new Error('内置运行环境已经安装，可直接进入模型准备或启动创作台');
        await mkdir(this.local, { recursive: true });
        signal.throwIfAborted();
        await action(signal);
        this.task.status = 'completed'; this.task.completedAt = Date.now(); delete this.task.error;
      } catch (error) {
        this.task.status = signal.aborted ? 'cancelled' : 'error';
        this.task.error = signal.aborted ? '任务已取消，已下载的进度会保留' : error.code === 'ENOSPC' ? '磁盘空间不足，请释放安装目录所在磁盘的空间后重试' : error.code === 'ENOENT' ? '找不到所选环境包或必要文件，请检查完整路径' : error.message || '运行环境安装失败';
      }
    })().finally(() => { this.pending = null; this.child = null; });
    return { ...this.task };
  }
  download() {
    if (!this.catalog.downloadUrl) throw new Error('运行环境下载链接尚未发布，请先下载离线环境包，再使用“导入环境包”');
    return this.launch(async signal => {
      const destination = path.join(this.local, 'runtime-' + this.catalog.packageId + '.zip.part');
      let offset = (await stat(destination).catch(() => null))?.size || 0;
      if (offset > this.catalog.bytes) { await rm(destination); offset = 0; }
      if (offset < this.catalog.bytes) {
        this.task.status = 'downloading'; this.task.received = offset;
        const modern = Number(process.versions.node.split('.')[0]) >= 25;
        const child = fork(path.join(here, 'model-download-worker.mjs'), [this.catalog.downloadUrl, String(offset)], {
          execPath: process.execPath, execArgv: modern ? ['--use-env-proxy', '--use-system-ca'] : [],
          windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', 'ipc'],
          env: { ...process.env, NO_PROXY: [process.env.NO_PROXY || process.env.no_proxy || '', '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',') }
        });
        this.child = child;
        const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('error', () => {});
        try {
          const headers = await new Promise((resolve, reject) => {
            let received = false;
            child.on('message', result => {
              if (result.error) { const error = new Error(result.error.replaceAll('模型', '运行环境')); if (received) child.stdout.destroy(error); else reject(error); }
              else if (!received) { received = true; resolve(result); }
            });
            child.once('error', reject);
            child.once('exit', code => { if (!received) reject(new Error('环境下载连接已结束，可稍后继续')); else if (code !== 0 && !child.stdout.destroyed) child.stdout.destroy(new Error('环境下载中断，可稍后继续下载')); });
          });
          signal.throwIfAborted();
          if (headers.status === 206 && !headers.contentRange?.startsWith(`bytes ${offset}-`)) throw new Error('下载服务器返回的断点范围不正确');
          if (headers.status !== 206) offset = 0;
          this.task.received = offset;
          const progress = new Transform({ transform: (chunk, _, done) => {
            this.task.received += chunk.length;
            if (this.task.received > this.catalog.bytes) done(new Error('下载内容超过清单大小，请检查发布文件')); else done(null, chunk);
          } });
          await pipeline(child.stdout, progress, createWriteStream(destination, { flags: offset ? 'a' : 'w' }), { signal });
        } finally { signal.removeEventListener('abort', abort); child.kill(); this.child = null; }
      }
      await this.install(destination, signal);
    });
  }
  importPath(source) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('请输入离线环境包的完整绝对路径');
    return this.launch(signal => this.install(path.resolve(source), signal));
  }
  importFile(source) {
    const file = path.resolve(source);
    if (path.dirname(file) !== this.local || !path.basename(file).startsWith('runtime-upload-')) throw new Error('上传环境包临时路径不正确');
    return this.launch(async signal => { try { await this.install(file, signal); } finally { await rm(file, { force: true }); } });
  }
  async install(source, signal) {
    const file = await stat(source);
    if (!file.isFile() || file.size !== this.catalog.bytes) throw new Error('环境包大小与当前版本不匹配，请选择清单对应的完整 ZIP 文件');
    this.task.status = 'verifying'; this.task.received = 0; this.task.total = this.catalog.bytes;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) { signal.throwIfAborted(); hash.update(chunk); this.task.received += chunk.length; }
    if (hash.digest('hex').toLowerCase() !== this.catalog.sha256.toLowerCase()) throw new Error('环境包 SHA-256 校验失败，请重新下载；原环境未被替换');
    signal.throwIfAborted();
    const stage = path.join(this.local, 'runtime-install-' + randomUUID());
    try {
      this.task.status = 'extracting'; this.task.received = 0; this.task.total = this.catalog.unpackedBytes || file.size;
      await this.extract(source, stage, signal);
      signal.throwIfAborted();
      const python = path.join(stage, 'runtime/comfyui/python/python.exe');
      const comfy = path.join(stage, 'runtime/comfyui/ComfyUI');
      if (!await exists(python) || !await exists(path.join(comfy, 'main.py'))) throw new Error('环境包缺少 Python 或 ComfyUI 核心文件');
      this.task.status = 'checking';
      let observed = {};
      if (this.validateEnvironment) {
        try {
          const result = await execute(python, ['-I', '-B', '-c', 'import json,sys,torch,transformers,safetensors,aiohttp,comfyui_version;print(json.dumps({"python":sys.version,"torch":torch.__version__,"comfyUI":comfyui_version.__version__}))'], {
            cwd: comfy, windowsHide: true, timeout: 120000, maxBuffer: 1048576, signal,
            env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' }
          });
          observed = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        } catch { signal.throwIfAborted(); throw new Error('运行环境组件检查失败。请确认 Windows x64 与系统运行库，必要时安装环境包内的 VC_redist.x64.exe 后重新导入'); }
      }
      signal.throwIfAborted();
      if (await this.available()) throw new Error('检测到已经安装的运行环境，本次导入已停止以保留原环境');
      const runtime = path.join(this.root, 'runtime'); await mkdir(runtime, { recursive: true });
      const committed = [], backups = [];
      try {
        for (const name of ['comfyui', 'redist', 'runtime-manifest.json']) {
          const from = path.join(stage, 'runtime', name), target = path.join(runtime, name);
          if (!await exists(from)) { if (name === 'comfyui') throw new Error('环境包缺少核心目录'); continue; }
          if (await exists(target)) { const backup = path.join(this.local, 'runtime-previous-' + randomUUID()); await rename(target, backup); backups.push([backup, target]); }
          await rename(from, target); committed.push(target);
        }
        await writeFile(path.join(this.local, 'runtime-installed.json'), JSON.stringify({ packageId: this.catalog.packageId, sha256: this.catalog.sha256, installedAt: Date.now(), ...observed }, null, 2));
      } catch (error) {
        for (const target of committed.reverse()) { const moved = path.join(stage, 'rollback-' + randomUUID()); await rename(target, moved).catch(() => {}); }
        for (const [backup, target] of backups.reverse()) await rename(backup, target).catch(() => {});
        throw error;
      }
      for (const [backup] of backups) await this.removeOwnedStage(backup);
      this.task.received = this.task.total;
    } finally { await this.removeOwnedStage(stage); }
  }
  async extract(archive, stage, signal) {
    if (process.platform !== 'win32') throw new Error('内置环境安装目前支持 Windows x64，请使用已有 ComfyUI 接入模式');
    const executable = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : 'powershell.exe';
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'install-runtime.ps1'), '-ArchivePath', archive, '-RootPath', this.root, '-StagePath', stage, '-PackageId', this.catalog.packageId], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child; let stderr = '', output = '';
      const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', chunk => { output += chunk.toString(); let line; while ((line = output.indexOf('\n')) >= 0) { const value = output.slice(0, line).trim(); output = output.slice(line + 1); const progress = /^PROGRESS (\d+) (\d+)$/.exec(value); if (progress) { this.task.received = Number(progress[1]); this.task.total = Number(progress[2]); } } });
      child.stderr.on('data', chunk => { if (stderr.length < 4000) stderr += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', code => { signal.removeEventListener('abort', abort); this.child = null; if (code === 0) resolve(); else reject(new Error(signal.aborted ? '任务已取消' : '环境包解压失败：' + (stderr.trim().split(/\r?\n/)[0] || '请确认 ZIP 文件完整并检查安装目录的写入权限'))); });
    });
  }
  async removeOwnedStage(value) {
    const absolute = path.resolve(value);
    if (path.dirname(absolute) !== this.local || !/^runtime-(?:install|previous)-[a-f\d-]+$/i.test(path.basename(absolute))) throw new Error('安装临时目录校验失败');
    await rm(absolute, { recursive: true, force: true });
  }
  async cancel() { this.controller?.abort(); this.child?.kill(); await this.pending; return this.snapshot(); }
  async close() { await this.cancel(); }
}
