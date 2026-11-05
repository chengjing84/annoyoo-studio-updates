(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const base = location.protocol === 'file:' ? 'http://127.0.0.1:8765' : '';
  const dialog = $('localEngineDialog');
  let state = null, runtime = null, loading = false, generationBusy = false, timer = null, reportedDetection = null;
  let modelScanReady = false;
  let modelScanRevision = 0;
  const activeModel = () => !!state?.queuedModelIds?.length || ['queued', 'downloading', 'retrying', 'importing', 'verifying'].includes(state?.task?.status);
  const activeRuntime = () => !!runtime?.task && !['completed', 'error', 'cancelled'].includes(runtime.task.status);
  const gib = value => `${(Number(value || 0) / 1073741824).toFixed(2)} GiB`;
  const selectedMode = () => dialog.querySelector('[name=localEngineMode]:checked')?.value || 'external';
  function message(text = '', error = false) { $('localEngineFeedback').textContent = text; $('localEngineFeedback').classList.toggle('is-error', error); }
  async function request(route, body, timeout = 30000) {
    const response = await fetch(base + route, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作未完成，请重试。');
    return result;
  }
  const api = (action = '', body) => request('/api/local-engine' + (action ? '/' + action : ''), body);
  function sourceHint() {
    $('modelDownloadSourceHint').textContent = $('modelDownloadSource').value === 'mirror'
      ? '国内镜像通常可直连；中断后可续传，完成后自动校验。'
      : '直接连接 Hugging Face，部分国内网络可能需要代理。';
  }
  function badge(id, text, ready = false) { $(id).textContent = text; $(id).dataset.ready = String(ready); }
  function link(id, value) {
    let url; try { url = new URL(value); } catch {}
    const valid = url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    $(id).setAttribute('aria-disabled', String(!valid));
    if (valid) $(id).href = url.href; else $(id).removeAttribute('href');
  }
  function modeFields() {
    const builtin = selectedMode() === 'builtin';
    $('enginePreparation').hidden = !builtin;
    $('externalEngineFields').hidden = builtin; $('externalComfyUrl').required = !builtin;
    $('builtinEngineFields').hidden = !builtin;
    $('localEngineTitle').textContent = builtin ? '本地环境与模型' : '连接已有 ComfyUI';
    $('localEngineSubtitle').textContent = builtin ? '准备好下面两项，就可以在本机生成图片。' : '沿用现有环境与模型，无需重复下载。';
    $('stopBuiltinEngine').hidden = !state?.engine?.owned;
  }
  function controls() {
    const busy = loading || activeModel() || activeRuntime(), builtin = selectedMode() === 'builtin';
    dialog.querySelectorAll('form input,form textarea,form button').forEach(control => { control.disabled = busy || generationBusy; });
    for (const id of ['downloadAllModels', 'detectLocalModels', 'modelDownloadSource']) $(id).disabled = busy || generationBusy || !state;
    $('downloadAllModels').disabled ||= !!state && state.models.every(model => model.verified);
    $('engineDownloadRuntime').disabled = busy || generationBusy || !runtime?.downloadConfigured || !!runtime?.available;
    $('engineDetectRuntime').disabled = busy || !state;
    $('copyModelDirectory').disabled = !state;
    dialog.querySelectorAll('[data-reset]').forEach(button => { button.disabled = busy || generationBusy; });
    $('cancelModelTransfer').disabled = loading || !activeModel();
    $('cancelModelTransfer').hidden = !activeModel();
    $('engineCancelRuntime').hidden = !activeRuntime();
    $('engineCancelRuntime').disabled = loading || ['extracting', 'checking', 'installing', 'validating'].includes(runtime?.task?.status);
    $('startBuiltinEngine').hidden = !builtin && !state?.engine?.comfyDirectory;
    $('startBuiltinEngine').textContent = state?.engine?.owned ? '返回创作台' : builtin ? '启动本地生图' : '启动已有 ComfyUI';
    $('startBuiltinEngine').disabled = busy || generationBusy || !state || !state.engine.owned && (builtin ? !runtime?.available || !modelScanReady : !state.engine.comfyDirectory);
    $('engineReadyHint').textContent = state?.engine?.owned ? state.engine.phase === 'starting' ? '本地引擎正在启动，请稍候。' : '本地引擎已运行。' : builtin ? modelScanReady ? '运行环境与模型已找到，可以启动。' : '准备运行环境和模型后，即可开始生图。' : '保存后，回到创作台检查连接。';
  }
  function renderRuntime() {
    if (!state) return;
    const available = runtime?.available ?? state.engine.builtinAvailable;
    $('engineRuntimeTitle').textContent = runtime?.bundled ? '内置运行环境' : '下载环境配置包';
    $('engineDownloadRuntime').hidden = !!runtime?.bundled;
    $('engineRuntimeManual').hidden = !!runtime?.bundled && available;
    badge('engineRuntimeState', available ? '已就绪' : activeRuntime() ? '准备中' : '待准备', available);
    $('engineRuntimeHint').textContent = runtime?.bundled ? available ? '整合包已附带 Python、PyTorch 和 ComfyUI。' : '整合包环境不完整，请重新下载完整整合包。' : available ? '环境已就绪，无需重复下载。' : runtime?.downloadConfigured || runtime?.manualUrl || runtime?.quarkUrl
      ? '包含 Python 和 ComfyUI，只需准备一次。'
      : '下载地址待发布。已有环境包可放到指定位置后检测。';
    $('engineRuntimeDirectory').textContent = runtime?.runtimeRoot || `${state.engine.projectRoot || state.modelRoot.replace(/[\\/]models$/, '')}/runtime`;
    link('engineRuntimeManual', runtime?.bundled ? runtime.fullPackageUrl : runtime?.manualUrl || runtime?.quarkUrl || runtime?.downloadUrl);
    $('engineRuntimeManual').textContent = /^https:\/\/(?:pan|drive)\.quark\.cn\//.test($('engineRuntimeManual').href || '') ? '夸克网盘 ↗' : '手动下载 ↗';
    const task = runtime?.task;
    $('engineRuntimeTransfer').hidden = !task || ['completed', 'cancelled'].includes(task.status);
    if (task) {
      const labels = { queued: '准备中', downloading: '正在下载环境', verifying: '正在校验环境', extracting: '正在安装环境', checking: '正在检查环境', error: '环境准备未完成' };
      $('engineRuntimeTransferLabel').textContent = labels[task.status] || '正在准备环境';
      if (task.total && task.status === 'downloading') { $('engineRuntimeProgress').max = task.total; $('engineRuntimeProgress').value = task.received || 0; }
      else $('engineRuntimeProgress').removeAttribute('value');
      $('engineRuntimeTransferDetail').textContent = task.error || (task.total ? `${gib(task.received)} / ${gib(task.total)}` : '请保持创作台运行。');
    }
  }
  async function renderModels() {
    const revision = ++modelScanRevision;
    const snapshot = state;
    modelScanReady = false;
    $('localModelDirectory').textContent = state.modelRoot;
    let all = { diffusion: [], textEncoder: [], vae: [], loras: [] }, presets = [];
    try {
      const catalog = await request('/api/models?refresh=1');
      if (revision !== modelScanRevision || state !== snapshot) return;
      all = catalog.all || all; presets = catalog.presets || [];
    } catch (error) {
      if (revision !== modelScanRevision || state !== snapshot) return;
      badge('engineModelsState', '模型扫描未完成', false);
      message(error.message, true);
      controls();
      return;
    }
    const counts = {
      diffusion: (all.diffusion || []).length,
      textEncoder: (all.textEncoder || []).length,
      vae: (all.vae || []).length,
      loras: (all.loras || []).length
    };
    const anyMissing = presets.some(p => p.missing?.length);
    modelScanReady = !!(counts.diffusion && counts.textEncoder && counts.vae && !anyMissing);
    if (counts.diffusion + counts.textEncoder + counts.vae + counts.loras === 0) {
      badge('engineModelsState', '尚未扫描到任何模型', false);
    } else if (anyMissing) {
      const totalMissing = presets.reduce((s, p) => s + (p.missing?.length || 0), 0);
      badge('engineModelsState', `已扫描 · 有 ${totalMissing} 项待补充`, false);
    } else {
      badge('engineModelsState', `已就绪 · UNet ${counts.diffusion} / CLIP ${counts.textEncoder} / VAE ${counts.vae} · LoRA ${counts.loras}`, true);
    }
    $('downloadAllModels').textContent = state.models.every(model => model.verified) ? '标准模型已校验' : modelScanReady ? '下载标准三件套' : '自动下载三件套';
    link('modelQuarkLink', /^https:\/\/(?:pan|drive)\.quark\.cn\//.test(state.quarkUrl || '') ? state.quarkUrl : '');
    $('modelQuarkHint').textContent = state.quarkCode ? `从夸克网盘下载后，将 models 文件夹放到创作台根目录。提取码：${state.quarkCode}。` : '从夸克网盘下载后，将 models 文件夹放到创作台根目录。';
    const task = state.task;
    $('modelTransfer').hidden = !task || ['completed', 'cancelled'].includes(task.status);
    if (task) {
      const title = state.models.find(model => model.id === task.modelId)?.name || '模型';
      const labels = { queued: '准备中', downloading: '下载中', retrying: '连接中断，正在重试', importing: '导入中', verifying: '正在校验', error: '未完成' };
      $('modelTransferLabel').textContent = task.kind === 'detection' ? `检测模型 · ${labels[task.status] || task.status}` : `${title} · ${labels[task.status] || task.status}`;
      $('modelTransferProgress').max = task.total || 1; $('modelTransferProgress').value = task.received || 0;
      $('modelTransferDetail').textContent = task.error || [task.kind === 'detection' ? title : `${gib(task.received)} / ${gib(task.total)}`, task.sourceName].filter(Boolean).join(' · ');
      if (task.kind === 'detection' && ['completed', 'error'].includes(task.status) && reportedDetection !== task.startedAt) {
        reportedDetection = task.startedAt;
        message(task.status === 'error' ? task.error : task.missingIds?.length ? `检测完成，还缺少 ${task.missingIds.length} 个标准模型；自定义模型可使用目录扫描结果。` : '三个标准模型已通过 SHA-256 校验。', task.status === 'error');
      }
    }
  }
  const KIND_LABELS = { diffusion: 'UNet', text_encoders: 'CLIP', vae: 'VAE', loras: 'LoRA' };
  const KIND_OPTIONS = Object.keys(KIND_LABELS);
  function normalizeConfigs(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(item => {
      if (typeof item === 'string') return { path: item.trim(), kinds: KIND_OPTIONS.slice() };
      if (item && typeof item.path === 'string') return { path: item.path.trim(), kinds: Array.isArray(item.kinds) ? item.kinds : KIND_OPTIONS.slice() };
      return null;
    }).filter(c => c?.path);
  }
  function renderModelDirectoryList(configs) {
    const list = $('modelDirectoryList');
    list.replaceChildren();
    const items = configs.length ? configs : [{ path: '', kinds: KIND_OPTIONS.slice() }];
    items.forEach((cfg, idx) => {
      const row = document.createElement('div'); row.className = 'engine-dir-row';
      const input = document.createElement('input'); input.type = 'text'; input.className = 'engine-dir-path'; input.value = cfg.path || ''; input.placeholder = '例如 D:\\ComfyUI\\ComfyUI\\models';
      input.addEventListener('change', () => { cfg.path = input.value.trim(); });
      const kindBox = document.createElement('div'); kindBox.className = 'engine-dir-kinds';
      KIND_OPTIONS.forEach(k => {
        const label = document.createElement('label');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = k;
        if (cfg.kinds.includes(k)) cb.checked = true;
        cb.addEventListener('change', () => {
          cfg.kinds = [...kindBox.querySelectorAll('input:checked')].map(c => c.value);
        });
        label.append(cb, document.createTextNode(' ' + KIND_LABELS[k]));
        kindBox.append(label);
      });
      const del = document.createElement('button'); del.type = 'button'; del.className = 'gen-text-button'; del.textContent = '删除';
      del.addEventListener('click', () => { items.splice(idx, 1); renderModelDirectoryList(items); });
      const footer = document.createElement('div'); footer.className = 'engine-dir-footer';
      footer.append(kindBox, del);
      row.append(input, footer);
      list.append(row);
    });
    list._items = items;
  }
  function readModelDirectoryConfigs() {
    const items = $('modelDirectoryList')._items || [];
    return items.filter(c => c.path && c.path.trim()).map(c => ({ path: c.path.trim(), kinds: c.kinds || KIND_OPTIONS.slice() }));
  }
  async function refresh(fill = false) {
    const [next, environment] = await Promise.all([api(), request('/api/runtime').catch(() => null)]);
    state = next; runtime = environment || { available: state.engine.builtinAvailable };
    if (fill) {
      let savedSource; try { savedSource = localStorage.getItem('pose-atlas-model-download-source'); } catch {}
      $('modelDownloadSource').value = (state.downloadSources || []).some(item => item.id === savedSource) ? savedSource : state.defaultDownloadSource || 'official';
      dialog.querySelector(`[name=localEngineMode][value=${state.engine.mode}]`).checked = true;
      $('externalComfyUrl').value = state.engine.externalUrl;
      renderModelDirectoryList(normalizeConfigs(state.engine.modelDirectories));
      $('engineConnectionOptions').open = state.engine.mode === 'external';
    }
    if (activeModel() && state.task?.sourceId) $('modelDownloadSource').value = state.task.sourceId;
    sourceHint(); modeFields(); renderRuntime(); await renderModels(); controls();
    if (state.engine.phase === 'error') message(state.engine.error, true);
    clearTimeout(timer);
    if (activeModel() || activeRuntime() || dialog.open && state.engine.phase === 'starting') timer = setTimeout(poll, 1500);
    return state;
  }
  async function poll() {
    try { await refresh(); if (state.engine.phase === 'running') document.dispatchEvent(new CustomEvent('local-engine-ready')); }
    catch (error) { message(error.message, true); if (dialog.open || activeModel() || activeRuntime()) timer = setTimeout(poll, 4000); }
  }
  async function perform(action, body, success) {
    loading = true; controls();
    try { await api(action, body); await refresh(); if (success && !(action === 'detect-models' && ['completed', 'error'].includes(state.task?.status))) message(success); return true; }
    catch (error) { message(error.message, true); return false; }
    finally { loading = false; controls(); }
  }
  const connectionChanged = () => document.dispatchEvent(new CustomEvent('local-engine-changed'));
  $('openLocalEngine').addEventListener('click', async () => {
    dialog.showModal(); document.body.classList.add('engine-open'); loading = true; message(); controls();
    try { await refresh(true); } catch (error) { message('无法读取配置，请从“启动创作台.cmd”打开页面。' + error.message, true); }
    finally { loading = false; controls(); }
    let automatic = false; try { automatic = sessionStorage.getItem('pose-atlas-download-models-once') === '1'; sessionStorage.removeItem('pose-atlas-download-models-once'); } catch {}
    if (automatic && state?.engine?.mode === 'builtin' && !activeModel() && !activeRuntime() && !state.models.every(model => model.verified)) perform('download-all', { source: $('modelDownloadSource').value }, '正在自动下载模型，完成后会放到指定位置并校验。');
  });
  $('closeLocalEngine').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { document.body.classList.remove('engine-open'); clearTimeout(timer); if (activeModel() || activeRuntime()) timer = setTimeout(poll, 1500); });
  dialog.querySelectorAll('[name=localEngineMode]').forEach(input => input.addEventListener('change', () => { modeFields(); controls(); }));
  $('refreshLocalEngine').addEventListener('click', async () => { try { await refresh(true); connectionChanged(); } catch (error) { message(error.message, true); } });
  $('localEngineForm').addEventListener('submit', async event => {
    event.preventDefault();
    const body = { mode: selectedMode(), externalUrl: $('externalComfyUrl').value.trim(), modelDirectories: readModelDirectoryConfigs() };
    if (await perform('configure', body, '设置已保存。已有模型目录可直接检测。')) connectionChanged();
  });
  $('addModelDirectory')?.addEventListener('click', () => {
    const items = $('modelDirectoryList')._items || [];
    items.push({ path: '', kinds: KIND_OPTIONS.slice() });
    renderModelDirectoryList(items);
  });
  $('startBuiltinEngine').addEventListener('click', async () => {
    if (state?.engine?.owned) { dialog.close(); return; }
    if (await perform('start', {}, '本地引擎正在启动。')) connectionChanged();
  });
  $('stopBuiltinEngine').addEventListener('click', async () => { if (await perform('stop', {}, '本地引擎已停止。')) connectionChanged(); });
  $('detectLocalModels').addEventListener('click', () => perform('detect-models', {}, '正在校验标准模型，大文件可能需要一些时间。'));
  $('downloadAllModels').addEventListener('click', () => perform('download-all', { source: $('modelDownloadSource').value }, '正在自动下载，完成后会放到指定位置并校验。'));
  $('cancelModelTransfer').addEventListener('click', () => perform('cancel', {}, '任务已取消，已有下载进度保留。'));
  $('modelDownloadSource').addEventListener('change', () => { sourceHint(); try { localStorage.setItem('pose-atlas-model-download-source', $('modelDownloadSource').value); } catch {} });
  $('copyModelDirectory').addEventListener('click', async () => { try { await navigator.clipboard.writeText(state.modelRoot); message('模型文件夹路径已复制。'); } catch { message('请选中上方路径并复制。'); } });
  $('modelQuarkLink').addEventListener('click', event => { if ($('modelQuarkLink').getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; } $('modelDownloadOptions').open = true; });
  $('engineRuntimeManual').addEventListener('click', event => { if ($('engineRuntimeManual').getAttribute('aria-disabled') === 'true') event.preventDefault(); else $('engineRuntimeManual').closest('section').querySelector('details').open = true; });
  $('engineDetectRuntime').addEventListener('click', async () => { loading = true; controls(); try { await refresh(); message(runtime.available ? '环境已就绪，可以继续准备 Qwen 模型。' : '还未检测到环境。请将 runtime 文件夹放到创作台根目录后重试。'); } catch (error) { message(error.message, true); } finally { loading = false; controls(); } });
  async function runtimeAction(action) { loading = true; controls(); try { await request('/api/runtime/' + action, {}); await refresh(); message(action === 'cancel' ? '环境下载已取消。' : '正在下载并安装环境，请保持创作台运行。'); } catch (error) { message(error.message, true); } finally { loading = false; controls(); } }
  $('engineDownloadRuntime').addEventListener('click', () => runtimeAction('download'));
  $('engineCancelRuntime').addEventListener('click', () => runtimeAction('cancel'));
  document.addEventListener('generation-busy-changed', event => { generationBusy = event.detail === true; controls(); });
  controls();
})();
