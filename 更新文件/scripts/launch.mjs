import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const runtimeRoot = join(projectRoot, '.local');
const portableNode = join(projectRoot, 'runtime', 'node', 'node.exe');

const args = process.argv.slice(2);
const noBrowser = args.some(a => a === '--no-browser' || a === '-n');

let edition = 'local';
const editionPath = join(projectRoot, 'config', 'edition.json');
if (existsSync(editionPath)) {
    try {
        const cfg = JSON.parse(readFileSync(editionPath, 'utf8'));
        if (cfg.edition === 'api' || cfg.edition === 'studio') edition = cfg.edition;
    } catch {}
}

mkdirSync(runtimeRoot, { recursive: true });

const nodeExecutable = existsSync(portableNode) ? portableNode : process.execPath;
const requestedPort = parseInt(process.env.GALLERY_PORT, 10) || 8765;

function checkPortFree(port) {
    return new Promise((resolve) => {
        const srv = createServer();
        srv.once('error', () => resolve(false));
        srv.once('listening', () => { srv.close(() => resolve(true)); });
        srv.listen(port, '127.0.0.1');
    });
}

async function getHealth(port) {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return await res.json();
    } catch {}
    return null;
}

let galleryPort = null;
let galleryHealth = null;
for (let port = requestedPort; port <= Math.min(65535, requestedPort + 40); port++) {
    const health = await getHealth(port);
    if (health && health.projectRoot === projectRoot && health.edition !== edition) {
        console.error('这个项目当前运行的是另一个版本，请先停止后再启动。');
        process.exit(1);
    }
    if (health && health.projectRoot === projectRoot && health.edition === edition) {
        galleryPort = port;
        galleryHealth = health;
        break;
    }
    if (await checkPortFree(port)) { galleryPort = port; break; }
}
if (!galleryPort) { console.error('找不到可用端口。'); process.exit(1); }

const galleryUrl = `http://127.0.0.1:${galleryPort}`;

// server 已在跑，直接打印并退出
if (galleryHealth) {
    writeFileSync(join(runtimeRoot, 'server-instance.json'), JSON.stringify({ pid: galleryHealth.pid, port: galleryPort, projectRoot }, null, 0));
    writeFileSync(join(runtimeRoot, 'server.pid'), String(galleryHealth.pid), 'ascii');
    console.log(`POSE Atlas 已在运行: ${galleryUrl}`);
    if (!noBrowser) openBrowser(galleryUrl);
    process.exit(0);
}

// 启动 server（前台持有，stdio inherit 让输出可见）
const serverEntry = edition === 'api' ? 'api-server.mjs' : edition === 'studio' ? 'studio-server.mjs' : 'gallery-server.mjs';
const serverFile = join(__dirname, serverEntry);
const env = { ...process.env, GALLERY_PORT: String(galleryPort), GALLERY_ROOT: projectRoot };
if (edition === 'api' || edition === 'studio') {
    const prev = env.NO_PROXY ? env.NO_PROXY + ',' : '';
    env.NO_PROXY = prev + '127.0.0.1,localhost,::1';
}

const child = spawn(nodeExecutable, [...((edition === 'api' || edition === 'studio') && Number(process.versions.node.split('.')[0]) >= 25 ? ['--use-env-proxy', '--use-system-ca'] : []), serverFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: projectRoot,
    env,
    windowsHide: true,
});

// 透传 server 输出
child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));

// 捕获启动错误，避免找不到可执行文件时留下未处理的 error 事件。
let startupError = null;
child.on('error', error => { startupError = error; console.error('服务启动失败：' + error.message); });
// 等健康检查
let started = false;
for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 300));
    const h = await getHealth(galleryPort);
    if (h && h.projectRoot === projectRoot && h.pid === child.pid && h.edition === edition) {
        galleryHealth = h;
        started = true;
        break;
    }
    if (startupError || child.exitCode !== null) break;
}

if (!started) {
    console.error('\n启动失败，请查看上方输出。');
    killProcessTree(child.pid);
    process.exit(1);
}

writeFileSync(join(runtimeRoot, 'server-instance.json'), JSON.stringify({ pid: galleryHealth.pid, port: galleryPort, projectRoot }, null, 0));
writeFileSync(join(runtimeRoot, 'server.pid'), String(galleryHealth.pid), 'ascii');

console.log(`\nPOSE Atlas: ${galleryUrl}`);
if (edition === 'studio') console.log('Studio 版：在设置页选择内置引擎或连接外部 ComfyUI。');
else if (edition === 'api') console.log('API 版：在应用内配置图像 API 端点。');
else console.log('本地版：内置 ComfyUI 或连接你已有的 ComfyUI。');
console.log(`输出目录: ${join(projectRoot, 'output')}`);
console.log('关闭此窗口即可停止服务。\n');

if (!noBrowser) openBrowser(galleryUrl);

// 用 taskkill /T /F 杀进程树（确保孙子进程也死，比如 ComfyUI python）
function killProcessTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
        } else {
            spawnSync('pkill', ['-P', String(pid)]);
            spawnSync('kill', ['-9', String(pid)]);
        }
    } catch {}
}

// 只在退出时终止本启动器创建的子进程，不根据 PID 文件清理进程。
// Ctrl+C / 窗口关闭 → 杀进程树然后退出
let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[launch] 正在停止服务…');
    const pid = child?.pid;
    if (pid) killProcessTree(pid);
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
// Windows 上关闭 CMD 窗口时 Node 进程被直接 terminate
// 在退出前拦截能清多少清多少
process.on('beforeExit', shutdown);

// 子进程退出了，启动器跟着退
child.on('exit', (code) => {
    if (!shuttingDown) {
        console.log(`\nServer 已退出 (code=${code ?? 'null'})。`);
        // 清理 ComfyUI python 残留
        if (galleryHealth?.pid && galleryHealth.pid !== child.pid) killProcessTree(galleryHealth.pid);
    }
    process.exit(code ?? 0);
});

function openBrowser(url) {
    try {
        let cmd, args, opts;
        if (process.platform === 'win32') {
            // 用 %windir%\System32\cmd.exe 绝对路径，避免 PATH 里找不到
            const windir = process.env.windir || process.env.SystemRoot || 'C:\\Windows';
            cmd = join(windir, 'System32', 'cmd.exe');
            // cmd /c start "" url  —— "" 是空标题占位，URL 作为第二个参数
            args = ['/c', 'start', '', url];
            opts = { stdio: 'ignore', detached: true, windowsHide: true };
        } else if (process.platform === 'darwin') {
            cmd = 'open';
            args = [url];
            opts = { stdio: 'ignore', detached: true };
        } else {
            cmd = 'xdg-open';
            args = [url];
            opts = { stdio: 'ignore', detached: true };
        }
        const b = spawn(cmd, args, opts);
        b.on('error', (e) => console.error('[launch] openBrowser 失败:', e.message));
        b.unref();
    } catch (e) {
        console.error('[launch] openBrowser 异常:', e.message);
    }
}
