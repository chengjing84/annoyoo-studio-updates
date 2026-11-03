(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = null, runtime = null, loading = false, uploadBusy = false, loaded = false, timer = null;
  let automaticModels = false;
  const selectedMode = () => document.querySelector('[name=studioMode]:checked').value;
  const launchExisting = () => document.querySelector('[name=externalConnection]:checked').value === 'launch';
  const activeRuntime = () => uploadBusy || !!runtime?.task && !['completed', 'error', 'cancelled'].includes(runtime.task.status);
  const bytes = value => Number(value) >= 1000000000 ? `${(Number(value) / 1000000000).toFixed(2)} GB` : `${(Number(value || 0) / 1000000).toFixed(1)} MB`;
  function feedback(text, error = false) { $('setupFeedback').textContent = text; $('setupFeedback').classList.toggle('is-error', error); }
  async function api(route, body, timeout = 30000) {
    const response = await fetch(route, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
    return result;
  }
  function fields() {
    const mode = selectedMode(), launch = launchExisting();
    $('setupApi').hidden = mode !== 'api'; $('setupBuiltin').hidden = mode !== 'builtin'; $('setupExternal').hidden = mode !== 'external';
    $('externalUrlFields').hidden = launch; $('externalPathFields').hidden = !launch;
    $('setupApiEndpoint').required = mode === 'api'; $('setupApiModel').required = mode === 'api';
    $('setupApiKey').required = mode === 'api' && !state?.api?.keyConfigured;
    $('setupComfyUrl').required = mode === 'external' && !launch;
    $('setupComfyDirectory').required = mode === 'external' && launch; $('setupPythonExecutable').required = mode === 'external' && launch;
    $('setupApiEndpointHint').textContent = $('setupApiProtocol').value === 'lk-media' ? 'LK tt-image-2.5 使用 /v1/media/generate 提交后查询原任务，避免长连接断开丢失结果。只填域名会自动补齐路径。' : $('setupApiProtocol').value === 'qwen-json' ? '只填域名默认使用 /v1/images/generations；也可填写自定义基础地址或完整接口路径。' : '只填域名默认使用 /v1/images/edits；也可填写自定义基础地址或完整接口路径。';
    $('finishSetup').textContent = mode === 'builtin' ? '进入创作台' : '保存并进入创作台';
    $('setupNextHint').textContent = mode === 'builtin' ? runtime?.available ? '环境已就绪，进入后可下载或检测模型。' : '准备环境后即可继续。' : mode === 'api' ? '保存后在创作台中选择参考并生成。' : launch ? '保存后使用所选 Python 启动 ComfyUI。' : '保存后使用该 ComfyUI 的模型与配置。';
    controls();
  }
  function controls() {
    const transfer = activeRuntime();
    $('setupForm').querySelectorAll('input,select,button').forEach(field => { field.disabled = loading || !loaded; });
    document.querySelectorAll('[name=studioMode]').forEach(field => { field.disabled = loading || !loaded || transfer; });
    $('finishSetup').disabled = loading || !loaded || transfer || selectedMode() === 'builtin' && !runtime?.available;
    for (const id of ['downloadRuntime', 'importRuntimePath', 'runtimeArchiveFile', 'installDetectedRuntime']) $(id).disabled = loading || !loaded || transfer || !!runtime?.available;
    $('downloadRuntime').disabled ||= !runtime?.downloadConfigured;
    $('setupAutomaticModels').disabled = loading || !loaded || transfer || !runtime?.available;
    $('detectPlacedRuntime').disabled = loading || !loaded || transfer;
    $('cancelRuntime').disabled = loading || !transfer || uploadBusy || ['extracting', 'installing', 'validating', 'checking'].includes(runtime?.task?.status);
    if (uploadBusy) $('cancelRuntime').title = '文件导入期间请保持页面打开'; else $('cancelRuntime').removeAttribute('title');
    for (const id of ['setupApi', 'setupBuiltin', 'setupExternal', 'externalUrlFields', 'externalPathFields']) {
      if ($(id).hidden) $(id).querySelectorAll('input,select,button').forEach(field => { field.disabled = true; });
    }
  }
  function renderRuntime(value) {
    runtime = value || {};
    $('setupRuntimeTitle').textContent = runtime.bundled ? '内置运行环境' : '下载环境配置包';
    $('runtimeStateLabel').textContent = runtime.available ? '环境已就绪' : activeRuntime() ? '正在准备运行环境' : runtime.bundled ? '整合包环境不完整' : '首次使用需要准备运行环境';
    $('runtimePackageDetail').textContent = runtime.bundled ? runtime.available ? '整合包已附带 Python、PyTorch 和 ComfyUI，无需额外安装。' : '请重新下载完整整合包，保留你的 models、output 和 .local 目录。' : runtime.available ? '使用本项目目录中的独立环境。' : [runtime.archiveName || 'Windows / NVIDIA 运行环境包', runtime.bytes ? bytes(runtime.bytes) : ''].filter(Boolean).join(' · ');
    $('runtimeInstallOptions').hidden = !!runtime.available || !!runtime.bundled;
    $('runtimeDownloadHint').textContent = runtime.downloadConfigured ? '自动下载并安装到指定目录。' : '环境下载地址待发布，已下载的文件可放好后检测。';
    $('setupRuntimeDirectory').textContent = runtime.runtimeRoot || '创作台根目录/runtime';
    const quark = runtime.manualUrl || runtime.quarkUrl || runtime.downloadUrl;
    $('runtimeQuarkLink').hidden = !quark;
    if (quark && /^https:\/\//.test(quark)) $('runtimeQuarkLink').href = quark;
    else $('runtimeQuarkLink').hidden = true;
    $('runtimeQuarkLink').textContent = /^https:\/\/(?:pan|drive)\.quark\.cn\//.test(quark || '') ? '夸克网盘 ↗' : '手动下载 ↗';
    $('detectedRuntimeArchive').hidden = !runtime.localArchive || !!runtime.available;
    $('detectedRuntimeArchiveName').textContent = runtime.localArchive ? `已找到离线环境包：${runtime.localArchive}` : '';
    const task = runtime.task; $('runtimeTask').hidden = !task && !uploadBusy;
    if (task) {
      const labels = { queued: '准备安装', downloading: '下载环境包', verifying: '校验环境包', extracting: '解压运行环境', installing: '安装运行环境', validating: '检查运行环境', checking: '检查运行环境', completed: '运行环境安装完成', error: '运行环境未安装成功', cancelled: '安装已取消', importing: '导入环境包' };
      $('runtimeTaskLabel').textContent = labels[task.status] || '正在准备运行环境';
      const received = task.received ?? task.receivedBytes ?? task.downloadedBytes ?? 0, total = task.total ?? task.totalBytes ?? runtime.bytes ?? 0;
      if (['downloading', 'importing'].includes(task.status) && total) { $('runtimeProgress').max = total; $('runtimeProgress').value = received; } else if (task.status === 'completed') { $('runtimeProgress').max = 1; $('runtimeProgress').value = 1; } else $('runtimeProgress').removeAttribute('value');
      $('runtimeTaskDetail').textContent = task.error || task.message || (['downloading', 'importing'].includes(task.status) ? `${bytes(received)} / ${bytes(total)}` : '大文件解压可能需要几分钟，请保持创作台运行。');
      $('cancelRuntime').hidden = ['completed', 'error', 'cancelled'].includes(task.status);
    }
    controls();
  }
  async function pollRuntime() {
    clearTimeout(timer);
    try {
      renderRuntime(await api('/api/runtime'));
      if (runtime.task?.status === 'completed') feedback('运行环境已安装，可以继续准备模型。');
      if (runtime.task?.status === 'error') feedback(runtime.task.error || '安装未完成，请检查环境包后重试。', true);
    } catch (error) { feedback(error.message, true); }
    finally { if (activeRuntime()) timer = setTimeout(pollRuntime, 1500); }
    fields();
  }
  async function runtimeAction(action, body) {
    if (loading || activeRuntime()) return;
    loading = true; controls(); feedback('正在准备安装任务…');
    try {
      const result = await api('/api/runtime/' + action, body, 30000);
      renderRuntime(result.runtime || result); feedback('安装任务已开始，完成后会自动检查环境。');
      timer = setTimeout(pollRuntime, 600);
    } catch (error) { feedback(error.message, true); }
    finally { loading = false; controls(); }
  }
  document.querySelectorAll('[name=studioMode],[name=externalConnection]').forEach(input => input.addEventListener('change', () => { feedback(''); fields(); }));
  $('setupApiProtocol').addEventListener('change', fields);
  $('downloadRuntime').addEventListener('click', () => runtimeAction('download', {}));
  $('detectPlacedRuntime').addEventListener('click', async () => { loading = true; controls(); try { renderRuntime(await api('/api/runtime')); fields(); feedback(runtime.available ? '环境已就绪，可以进入创作台准备模型。' : '未检测到环境，请将 runtime 文件夹放到创作台根目录后重试。'); } catch (error) { feedback(error.message, true); } finally { loading = false; controls(); } });
  $('setupAutomaticModels').addEventListener('click', () => { automaticModels = true; $('setupForm').requestSubmit(); });
  $('importRuntimePath').addEventListener('click', () => { const source = $('runtimeArchivePath').value.trim(); if (!source) { feedback('请填写运行环境压缩包的完整路径。', true); return; } runtimeAction('import-path', { source }); });
  $('installDetectedRuntime').addEventListener('click', () => runtimeAction('import-path', { source: runtime.localArchive }));
  $('cancelRuntime').addEventListener('click', async () => { try { await api('/api/runtime/cancel', {}); await pollRuntime(); } catch (error) { feedback(error.message, true); } });
  $('runtimeArchiveFile').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    if (runtime?.bytes && file.size !== runtime.bytes) { feedback('压缩包大小与当前运行环境清单不匹配，请选择对应版本。', true); event.target.value = ''; return; }
    uploadBusy = true; controls(); $('runtimeTask').hidden = false; $('runtimeTaskLabel').textContent = '正在导入环境包'; $('runtimeTaskDetail').textContent = '请保持页面打开，大文件也可使用完整路径导入。'; $('runtimeProgress').removeAttribute('value');
    try {
      const response = await fetch('/api/runtime/import-file', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '导入失败，请重试。');
      renderRuntime(result.runtime || result); feedback('文件已导入，正在校验并安装。');
    } catch (error) { feedback(error.message, true); }
    finally { uploadBusy = false; event.target.value = ''; await pollRuntime(); }
  });
  $('detectComfy').addEventListener('click', async () => {
    loading = true; controls(); $('detectComfyFeedback').textContent = '正在识别安装目录与 Python…';
    try {
      const found = await api('/api/setup/detect', { directory: $('setupComfyDirectory').value.trim() });
      const candidate = found.candidates?.find(item => item.pythonExecutable) || found.candidates?.[0];
      if (!candidate) throw new Error('未识别到 ComfyUI，请填写含 main.py 的目录和对应 Python 路径。');
      $('setupComfyDirectory').value = candidate.comfyDirectory; $('setupPythonExecutable').value = candidate.pythonExecutable || '';
      $('detectComfyFeedback').textContent = candidate.pythonExecutable ? '已识别 ComfyUI 和对应 Python，保存后可启动。' : '已识别 ComfyUI，请手动补充对应 Python 路径。';
    } catch (error) { $('detectComfyFeedback').textContent = error.message; }
    finally { loading = false; controls(); }
  });
  $('setupForm').addEventListener('submit', async event => {
    event.preventDefault(); if (loading || activeRuntime() || !loaded) return;
    const mode = selectedMode();
    const payload = { mode, start: mode === 'builtin' || mode === 'external' && launchExisting() };
    if (mode === 'api') payload.api = { endpoint: $('setupApiEndpoint').value.trim(), model: $('setupApiModel').value.trim(), apiKey: $('setupApiKey').value.trim(), protocol: $('setupApiProtocol').value, sizeMode: state?.api?.sizeMode || 'auto' };
    else payload.local = { externalUrl: $('setupComfyUrl').value.trim() || state?.local?.externalUrl || 'http://127.0.0.1:8188', modelDirectories: state?.local?.modelDirectories || [], comfyDirectory: mode === 'external' && launchExisting() ? $('setupComfyDirectory').value.trim() : '', pythonExecutable: mode === 'external' && launchExisting() ? $('setupPythonExecutable').value.trim() : '' };
    loading = true; controls(); feedback('正在保存设置并准备创作台…');
    try {
      const result = await api('/api/setup', payload, 90000); $('setupApiKey').value = '';
      if (mode === 'builtin' && automaticModels) { try { sessionStorage.setItem('pose-atlas-download-models-once', '1'); } catch {} }
      location.assign(mode === 'builtin' ? '/?models=1' : result.nextUrl || '/');
    } catch (error) { automaticModels = false; feedback(error.name === 'TimeoutError' ? '准备时间较长，请稍后重新打开此页面检查状态。' : error.message, true); loading = false; controls(); }
  });
  (async () => {
    try {
      state = await api('/api/setup'); runtime = state.runtime || {};
      $('setupModelDirectory').textContent = state.modelPreparation?.modelRoot || '创作台根目录/models';
      const modelShare = state.modelPreparation?.quarkUrl;
      $('setupManualModels').hidden = !/^https:\/\/(?:pan|drive)\.quark\.cn\//.test(modelShare || '');
      if (!$('setupManualModels').hidden) $('setupManualModels').href = modelShare;
      if (state.mode) document.querySelector(`[name=studioMode][value=${state.mode}]`).checked = true;
      $('returnToStudio').hidden = !state.configured;
      const settings = state.api || {};
      $('setupApiEndpoint').value = settings.endpoint || ''; $('setupApiModel').value = settings.model || ''; $('setupApiProtocol').value = settings.protocol || 'images-multipart';
      $('setupApiKeyState').textContent = settings.keyConfigured ? '已保存在本机' : '尚未配置'; $('setupApiKey').placeholder = settings.keyConfigured ? '留空保留原 Key，填写则替换' : '粘贴 API Key';
      const local = state.local || {};
      $('setupComfyUrl').value = local.externalUrl || 'http://127.0.0.1:8188'; $('setupComfyDirectory').value = local.comfyDirectory || ''; $('setupPythonExecutable').value = local.pythonExecutable || '';
      if (local.comfyDirectory && local.pythonExecutable && state.autoStart) document.querySelector('[name=externalConnection][value=launch]').checked = true;
      loaded = true; renderRuntime(runtime); fields(); if (activeRuntime()) timer = setTimeout(pollRuntime, 1000);
      if (state.switching) feedback('正在切换模式，请稍候。');
    } catch (error) { feedback('无法读取安装设置，请从“启动创作台.cmd”打开本机页面。' + error.message, true); }
  })();
})();
