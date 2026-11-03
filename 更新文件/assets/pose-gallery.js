(() => {
'use strict';
const ANGLES = ['正面', '俯视', '仰视', '侧面', '斜侧'];
const PAGE_SIZE = { pose: 60, single: 96 };
const state = { line: '', category: '', angle: '', query: '', view: 'pose', shown: PAGE_SIZE.pose };
const $ = selector => document.querySelector(selector);
const grid = $('#grid');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const format = value => Number(value).toLocaleString('zh-CN');
const icon = name => ({
  expand: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5"/></svg>',
  search: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m20 20-4.2-4.2"/></svg>'
}[name] || '');

let DATA = [];
let GROUPS = [];
let LINES = [];
let currentList = [];
let renderedCount = 0;
let selectedPoseId = document.querySelector('#selectedPoseImage')?.dataset.poseId || '';
let generationBusy = !!document.querySelector('#generationPrompt')?.disabled;
const groupMap = new Map();
const viewerState = { index: 0, item: null, token: 0, returnFocus: null };
const viewerInertElements = new Map();

function groupKey(item) { return `${item.体系}|${item.姿势编号 || item.id}`; }

function prepareData(data) {
  DATA = data;
  LINES = [...new Set(DATA.map(item => item.体系))];
  DATA.forEach(item => {
    const description = item.姿势词条;
    item._search = `${item.姿势名称} ${item.id} ${item.分类} ${item.姿势编号} ${description?.动作描述 || ''} ${description?.视角描述 || ''} ${Array.isArray(description?.关键词) ? description.关键词.join(' ') : ''}`.toLowerCase();
    const key = groupKey(item);
    if (!groupMap.has(key)) {
      const group = { key, system: item.体系, number: item.姿势编号, name: item.姿势名称, category: item.分类, items: [], angles: {}, order: [] };
      groupMap.set(key, group);
      GROUPS.push(group);
    }
    const group = groupMap.get(key);
    group.items.push(item);
    if (item.角度 && !group.angles[item.角度]) group.angles[item.角度] = item;
  });
  GROUPS.sort((a, b) => (LINES.indexOf(a.system) - LINES.indexOf(b.system)) || String(a.number).localeCompare(String(b.number)));
  GROUPS.forEach(group => {
    group.order = ANGLES.map(angle => group.angles[angle]).filter(Boolean);
    group.items.forEach(item => { if (!group.order.includes(item)) group.order.push(item); });
  });
  $('#descriptionCoverage').textContent = `${format(DATA.filter(item => item.姿势词条?.动作描述).length)} / ${format(DATA.length)} 张已有姿势词条`;
  renderTabs();
  renderCategoryOptions();
  renderAngleFilter();
  render();
}

function renderTabs() {
  const tabs = [['', '全部', DATA.length, GROUPS.length], ...LINES.map(line => [line, line, DATA.filter(item => item.体系 === line).length, GROUPS.filter(group => group.system === line).length])];
  $('#lineTabs').innerHTML = tabs.map(([value, label, images, poses]) => `<button class="line-tab" type="button" role="tab" data-line="${esc(value)}" aria-selected="${state.line === value}"><span class="tab-name">${esc(label)}</span><span class="tab-count">${format(images)} 张 · ${format(poses)} 组</span></button>`).join('');
}

function renderCategoryOptions() {
  const categories = [...new Set(DATA.filter(item => !state.line || item.体系 === state.line).map(item => item.分类).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  $('#categorySelect').innerHTML = '<option value="">全部分类</option>' + categories.map(category => `<option value="${esc(category)}"${state.category === category ? ' selected' : ''}>${esc(category)}</option>`).join('');
}

function renderAngleFilter() {
  $('#angleFilter').innerHTML = ['', ...ANGLES].map(angle => `<button type="button" data-angle="${esc(angle)}" aria-pressed="${state.angle === angle}">${angle || '全部视角'}</button>`).join('');
}

function hit(item) {
  return (!state.line || item.体系 === state.line) &&
    (!state.category || item.分类 === state.category) &&
    (!state.angle || item.角度 === state.angle) &&
    (!state.query || item._search.includes(state.query));
}

function computeList() {
  if (state.view === 'single') {
    return DATA.filter(hit).map(item => ({ group: groupMap.get(groupKey(item)), item, matched: 1 }));
  }
  return GROUPS.filter(group => group.items.some(hit)).map(group => ({
    group,
    item: group.order.find(hit) || group.order[0],
    matched: group.items.filter(hit).length
  }));
}

function cardImage(item, name, number) {
  return `<div class="card-image"><img class="main-image" src="${esc(item.缩略图)}" alt="${esc(name)} · ${esc(item.角度)}" loading="lazy" decoding="async"><div class="image-top"><span class="pose-no">${esc(number)}</span><span class="angle-tag">${esc(item.角度)}</span></div><span class="zoom-hint">${icon('expand')}</span></div>`;
}

function quickSelectButton(item) {
  const selected = item.id === selectedPoseId;
  return `<button class="wardrobe-select pose-select" type="button" aria-pressed="${selected}" aria-label="选用${esc(item.姿势名称)}，${esc(item.角度)}视角"${generationBusy ? ' disabled' : ''}>${selected ? '已选为姿势参考' : '选用此姿势'}</button>`;
}

function poseCard(entry, index) {
  const { group, item } = entry;
  const strip = ANGLES.filter(angle => group.angles[angle]).map(angle => {
    const angleItem = group.angles[angle];
    return `<button class="angle-thumb${angleItem === item ? ' on' : ''}" type="button" data-angle="${esc(angle)}" title="${esc(angle)}" aria-label="查看${esc(angle)}视角"><img src="${esc(angleItem.缩略图)}" alt="" loading="lazy" decoding="async"><span>${esc(angle)}</span></button>`;
  }).join('');
  return `<article class="pose-card${item.id === selectedPoseId ? ' is-selected' : ''}" tabindex="0" data-index="${index}" aria-label="${esc(group.name)}，${esc(item.角度)}视角">${cardImage(item, group.name, group.number)}<div class="card-body"><h3>${esc(group.name)}</h3><div class="card-meta"><span class="system">${esc(group.system)}</span><span class="meta-dot">·</span><span class="category">${esc(group.category)}</span></div></div><div class="angle-strip">${strip}</div>${quickSelectButton(item)}</article>`;
}

function singleCard(entry, index) {
  const { item } = entry;
  return `<article class="pose-card${item.id === selectedPoseId ? ' is-selected' : ''}" tabindex="0" data-index="${index}" aria-label="${esc(item.姿势名称)}，${esc(item.角度)}视角">${cardImage(item, item.姿势名称, item.姿势编号)}<div class="card-body"><h3>${esc(item.姿势名称)}</h3><div class="card-meta"><span class="system">${esc(item.体系)}</span><span class="meta-dot">·</span><span class="category">${esc(item.分类)}</span></div><code class="card-id">${esc(item.id)}</code></div>${quickSelectButton(item)}</article>`;
}

function syncControls() {
  document.querySelectorAll('#lineTabs .line-tab').forEach(button => button.setAttribute('aria-selected', button.dataset.line === state.line));
  document.querySelectorAll('#angleFilter button').forEach(button => button.setAttribute('aria-pressed', button.dataset.angle === state.angle));
  document.querySelectorAll('#viewFilter button').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === state.view));
  $('#searchClear').hidden = !state.query;
  const count = [state.category, state.angle].filter(Boolean).length + (state.view === 'single' ? 1 : 0);
  $('#filterBadge').textContent = count || '';
}

function renderActiveFilters() {
  const filters = [];
  if (state.line) filters.push(['line', `体系：${state.line}`]);
  if (state.category) filters.push(['category', `分类：${state.category}`]);
  if (state.angle) filters.push(['angle', `视角：${state.angle}`]);
  if (state.query) filters.push(['query', `搜索：${state.query}`]);
  if (state.view === 'single') filters.push(['view', '逐张浏览']);
  $('#activeFilters').innerHTML = filters.map(([key, label]) => `<button class="filter-chip" type="button" data-clear="${key}" title="移除此筛选">${esc(label)}</button>`).join('');
}

function render(append = false) {
  if (!append) {
    currentList = computeList();
    renderedCount = 0;
    grid.innerHTML = '';
  }
  const total = currentList.length;
  const visible = currentList.slice(renderedCount, state.shown);
  grid.insertAdjacentHTML('beforeend', visible.map((entry, offset) => state.view === 'pose' ? poseCard(entry, renderedCount + offset) : singleCard(entry, renderedCount + offset)).join(''));
  renderedCount += visible.length;

  if (state.view === 'pose') {
    const images = currentList.reduce((sum, entry) => sum + entry.matched, 0);
    $('#resultCount').textContent = `${format(total)} 组姿势 · ${format(images)} 张图片`;
  } else {
    $('#resultCount').textContent = `${format(total)} 张图片`;
  }
  $('#visibleCount').textContent = total > state.shown ? `已显示 ${format(renderedCount)} / ${format(total)} ${state.view === 'pose' ? '组' : '张'}` : `共 ${format(total)} ${state.view === 'pose' ? '组' : '张'}`;

  if (!total) {
    grid.innerHTML = `<div class="empty"><div class="empty-icon">${icon('search')}</div><h3>没有找到匹配的姿势</h3><p>试试更换关键词或减少筛选条件。</p><button type="button" id="emptyReset">清除全部筛选</button></div>`;
  }
  const more = $('#loadMore');
  more.hidden = renderedCount >= total || !total;
  more.textContent = `加载更多（剩余 ${format(total - renderedCount)} ${state.view === 'pose' ? '组' : '张'}）`;
  syncControls();
  renderActiveFilters();
}

function resetView() {
  state.shown = PAGE_SIZE[state.view];
  render();
}

function resetAll() {
  state.line = '';
  state.category = '';
  state.angle = '';
  state.query = '';
  state.view = 'pose';
  $('#searchInput').value = '';
  renderTabs();
  renderCategoryOptions();
  resetView();
}

function updateCardPreview(card, entry) {
  const item = entry.item;
  const image = card.querySelector('.main-image');
  image.src = item.缩略图;
  image.alt = `${entry.group.name} · ${item.角度}`;
  card.querySelector('.angle-tag').textContent = item.角度;
  card.setAttribute('aria-label', `${entry.group.name}，${item.角度}视角`);
  card.querySelectorAll('.angle-thumb').forEach(button => button.classList.toggle('on', button.dataset.angle === item.角度));
  updateCardSelection(card, item);
}

function updateCardSelection(card, item) {
  const selected = item.id === selectedPoseId;
  card.classList.toggle('is-selected', selected);
  const button = card.querySelector('.pose-select');
  button.setAttribute('aria-pressed', String(selected));
  button.setAttribute('aria-label', `选用${item.姿势名称}，${item.角度}视角`);
  button.textContent = selected ? '已选为姿势参考' : '选用此姿势';
  button.disabled = generationBusy;
}

function syncCardSelections() {
  grid.querySelectorAll('.pose-card[data-index]').forEach(card => {
    const item = currentList[Number(card.dataset.index)]?.item;
    if (item) updateCardSelection(card, item);
  });
}

document.addEventListener('pose-selection-changed', event => {
  selectedPoseId = event.detail?.id || '';
  syncCardSelections();
});
document.addEventListener('generation-busy-changed', event => {
  generationBusy = event.detail === true;
  syncCardSelections();
});

$('#lineTabs').addEventListener('click', event => {
  const button = event.target.closest('.line-tab');
  if (!button || button.dataset.line === state.line) return;
  state.line = button.dataset.line;
  state.category = '';
  renderCategoryOptions();
  resetView();
});

$('#categorySelect').addEventListener('change', event => {
  state.category = event.target.value;
  resetView();
});

$('#angleFilter').addEventListener('click', event => {
  const button = event.target.closest('button[data-angle]');
  if (!button) return;
  state.angle = button.dataset.angle;
  resetView();
});

$('#viewFilter').addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  resetView();
});

let searchTimer;
$('#searchInput').addEventListener('input', event => {
  $('#searchClear').hidden = !event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim().toLowerCase();
    resetView();
  }, 120);
});

$('#searchClear').addEventListener('click', () => {
  $('#searchInput').value = '';
  state.query = '';
  resetView();
  $('#searchInput').focus();
});

$('#filterToggle').addEventListener('click', () => {
  const open = $('#filterPanel').classList.toggle('open');
  $('#filterToggle').setAttribute('aria-expanded', String(open));
});

$('#resetFilters').addEventListener('click', resetAll);
$('#activeFilters').addEventListener('click', event => {
  const button = event.target.closest('button[data-clear]');
  if (!button) return;
  const key = button.dataset.clear;
  if (key === 'line') { state.line = ''; state.category = ''; renderTabs(); renderCategoryOptions(); }
  if (key === 'category') state.category = '';
  if (key === 'angle') state.angle = '';
  if (key === 'query') { state.query = ''; $('#searchInput').value = ''; }
  if (key === 'view') state.view = 'pose';
  resetView();
});

grid.addEventListener('click', event => {
  if (event.target.closest('#emptyReset')) { resetAll(); return; }
  const card = event.target.closest('.pose-card[data-index]');
  if (!card) return;
  const index = Number(card.dataset.index);
  const entry = currentList[index];
  if (event.target.closest('.pose-select')) {
    if (!generationBusy) document.dispatchEvent(new CustomEvent('pose-selected', { detail: entry.item }));
    return;
  }
  const angleButton = event.target.closest('.angle-thumb');
  if (angleButton && state.view === 'pose') {
    entry.item = entry.group.angles[angleButton.dataset.angle];
    updateCardPreview(card, entry);
  }
  openViewer(index, entry.item);
});

grid.addEventListener('mouseover', event => {
  const button = event.target.closest('.angle-thumb');
  if (!button || state.view !== 'pose') return;
  const card = button.closest('.pose-card[data-index]');
  const entry = currentList[Number(card.dataset.index)];
  const item = entry.group.angles[button.dataset.angle];
  if (!item || entry.item === item) return;
  entry.item = item;
  updateCardPreview(card, entry);
});

grid.addEventListener('keydown', event => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('.pose-card[data-index]')) {
    event.preventDefault();
    const index = Number(event.target.dataset.index);
    openViewer(index, currentList[index].item);
  }
});

$('#loadMore').addEventListener('click', () => {
  state.shown = Math.min(state.shown + PAGE_SIZE[state.view], currentList.length);
  render(true);
});

function openViewer(index, item) {
  viewerState.index = index;
  viewerState.item = item;
  viewerState.returnFocus = document.activeElement;
  $('#viewer').hidden = false;
  document.body.classList.add('viewer-open');
  for (const element of document.body.children) {
    if (element !== $('#viewer') && element.tagName !== 'SCRIPT') { viewerInertElements.set(element, element.inert); element.inert = true; }
  }
  showViewer();
  $('#viewer .viewer-side').scrollTop = 0;
  $('#viewerClose').focus({ preventScroll: true });
}

function closeViewer() {
  if ($('#viewer').hidden) return;
  viewerState.token++;
  $('#viewer').hidden = true;
  document.body.classList.remove('viewer-open');
  for (const [element, wasInert] of viewerInertElements) element.inert = wasInert;
  viewerInertElements.clear();
  if (viewerState.returnFocus && document.contains(viewerState.returnFocus)) viewerState.returnFocus.focus({ preventScroll: true });
}

function showViewer() {
  const entry = currentList[viewerState.index];
  if (!entry) return;
  const item = viewerState.item || entry.item;
  const group = entry.group;
  viewerState.item = item;
  entry.item = item;
  const card = grid.querySelector(`.pose-card[data-index="${viewerState.index}"]`);
  if (card) updateCardPreview(card, entry);
  const token = ++viewerState.token;
  const image = $('#viewerImage');
  image.src = item.缩略图;
  image.alt = `${item.姿势名称} · ${item.角度}`;
  image.classList.add('is-loading');
  $('#imageStatus').textContent = '正在加载原图…';
  $('#imageStatus').hidden = false;
  const full = new Image();
  full.decoding = 'async';
  full.onload = () => {
    if (token !== viewerState.token) return;
    image.src = item.原图;
    image.classList.remove('is-loading');
    $('#imageStatus').hidden = true;
  };
  full.onerror = () => {
    if (token !== viewerState.token) return;
    image.classList.remove('is-loading');
    $('#imageStatus').textContent = '原图加载失败，可点击新窗口重试';
    $('#imageStatus').hidden = false;
  };
  full.src = item.原图;

  $('#viewerNumber').textContent = item.姿势编号 || 'POSE';
  $('#viewerPosition').textContent = `${viewerState.index + 1} / ${currentList.length}`;
  $('#viewerTitle').textContent = item.姿势名称;
  renderPoseDescription(item);
  $('#viewerId').textContent = item.id;
  $('#copyId').textContent = '复制 ID';
  $('#viewerMeta').innerHTML = [['体系', item.体系], ['姿势编号', item.姿势编号 || '—'], ['动作分类', item.分类 || '—'], ['当前视角', item.角度 || '—'], ['图片规格', '900 × 1200 PNG']].map(([key, value]) => `<dt>${key}</dt><dd>${esc(value)}</dd>`).join('');
  $('#viewerAngles').innerHTML = ANGLES.filter(angle => group.angles[angle]).map(angle => {
    const angleItem = group.angles[angle];
    return `<button class="angle-thumb${angleItem === item ? ' on' : ''}" type="button" data-angle="${esc(angle)}" aria-label="切换到${esc(angle)}"><img src="${esc(angleItem.缩略图)}" alt="${esc(angle)}"><span>${esc(angle)}</span></button>`;
  }).join('');
  const download = $('#downloadImage');
  download.href = item.原图;
  download.setAttribute('download', `${item.id}.png`);
  $('#openImage').href = item.原图;
}

function stepAngle(direction) {
  const group = currentList[viewerState.index]?.group;
  if (!group || group.order.length < 2) return;
  const current = group.order.indexOf(viewerState.item);
  viewerState.item = group.order[(current + direction + group.order.length) % group.order.length];
  showViewer();
}

function stepPose(direction) {
  const next = viewerState.index + direction;
  if (next < 0 || next >= currentList.length) return;
  const angle = viewerState.item.角度;
  viewerState.index = next;
  viewerState.item = currentList[next].group.angles[angle] || currentList[next].item;
  showViewer();
}

$('#viewerClose').addEventListener('click', closeViewer);
function poseDescriptionText(entry) {
  if (!entry || !entry.动作描述) return '';
  return [entry.动作描述, entry.视角描述 ? `视角：${entry.视角描述}` : '', Array.isArray(entry.关键词) && entry.关键词.length ? `关键词：${entry.关键词.join('、')}` : '', Array.isArray(entry.不确定) && entry.不确定.length ? `不确定：${entry.不确定.join('；')}` : ''].filter(Boolean).join('\n');
}

function renderPoseDescription(item) {
  const entry = item.姿势词条;
  const available = !!entry?.动作描述;
  $('#viewerPoseDescription').textContent = available ? entry.动作描述 : '这张图片的姿势描述尚未生成，仍可查看原图或用此姿势生成。';
  $('#copyPoseDescription').disabled = !available;
  $('#copyPoseDescription').textContent = '复制描述';
  $('#viewerViewDescription').textContent = entry?.视角描述 ? `视角：${entry.视角描述}` : '';
  $('#viewerViewDescription').hidden = !entry?.视角描述;
  const keywords = Array.isArray(entry?.关键词) ? entry.关键词.filter(value => typeof value === 'string' && value.trim()) : [];
  $('#viewerPoseKeywords').innerHTML = keywords.map(keyword => `<span>${esc(keyword)}</span>`).join('');
  $('#viewerPoseKeywords').hidden = !keywords.length;
  const uncertainty = Array.isArray(entry?.不确定) ? entry.不确定.filter(value => typeof value === 'string' && value.trim()) : [];
  $('#viewerPoseUncertainty').textContent = uncertainty.length ? `图中无法确定：${uncertainty.join('；')}` : '';
  $('#viewerPoseUncertainty').hidden = !uncertainty.length;
}

$('#copyPoseDescription').addEventListener('click', async () => {
  const text = poseDescriptionText(viewerState.item?.姿势词条);
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const field = document.createElement('textarea');
      field.value = text;
      field.style.cssText = 'position:fixed;left:0;top:0;opacity:0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('复制不可用');
    }
    $('#copyPoseDescription').textContent = '已复制';
  } catch { $('#copyPoseDescription').textContent = '请手动选择文字复制'; }
});
$('#usePoseForGeneration').addEventListener('click', () => {
  if (!viewerState.item) return;
  const item = viewerState.item;
  closeViewer();
  document.dispatchEvent(new CustomEvent('pose-selected', { detail: item }));
});
$('#viewer').addEventListener('click', event => { if (event.target === $('#viewer')) closeViewer(); });
$('#anglePrev').addEventListener('click', () => stepAngle(-1));
$('#angleNext').addEventListener('click', () => stepAngle(1));
$('#viewerAngles').addEventListener('click', event => {
  const button = event.target.closest('button[data-angle]');
  if (!button) return;
  viewerState.item = currentList[viewerState.index].group.angles[button.dataset.angle];
  showViewer();
});

$('#copyId').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(viewerState.item.id);
    $('#copyId').textContent = '已复制';
  } catch {
    $('#copyId').textContent = '请手动复制';
  }
});

let touchStart = null;
$('#viewerStage').addEventListener('touchstart', event => {
  const touch = event.touches[0];
  touchStart = { x: touch.clientX, y: touch.clientY };
}, { passive: true });
$('#viewerStage').addEventListener('touchend', event => {
  if (!touchStart) return;
  const touch = event.changedTouches[0];
  const dx = touch.clientX - touchStart.x;
  const dy = touch.clientY - touchStart.y;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) stepAngle(dx < 0 ? 1 : -1);
  touchStart = null;
}, { passive: true });

document.addEventListener('keydown', event => {
  if ($('#libraryCostumes').getAttribute('aria-selected') === 'true' || !$('#costumeViewer').hidden) return;
  if (!$('#viewer').hidden) {
    if (event.key === 'Tab') {
      const controls = [...$('#viewer').querySelectorAll('button:not(:disabled),a[href]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    else if (event.key === 'Escape') closeViewer();
    else if (event.key === 'ArrowRight') stepAngle(1);
    else if (event.key === 'ArrowLeft') stepAngle(-1);
    else if (event.key === 'ArrowDown') { event.preventDefault(); stepPose(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); stepPose(-1); }
    return;
  }
  if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $('#searchInput').focus();
  }
});

const INFO = {
  guide: {
    title: '使用指南',
    html: '<ul><li>在<strong>组合生图</strong>中，可单独选择姿势、单独选择服装，也可同时使用两者；服装支持分类和关键词搜索。</li><li>人物参考1提供主角色身份，第二张默认是<strong>第二位人物</strong>，双人姿势分别绑定A与B；也可改为<strong>环境场景</strong>，只提取空间、背景和光照。需要同一人物的另一角度时，手动选择“同一人物补充”。</li><li>环境图不作为另一个人物，也不能代替人物描述；有人物参考1时，画面描述可留空。所选服装默认提供人物穿搭，可在描述中指定穿着对象。</li><li>生成结果自动保存到本项目的 <strong>output/</strong> 文件夹，网页关闭后仍会保存，请保持画廊服务与 ComfyUI 运行。</li><li>姿势卡片可切换角度、下载 <strong>900 × 1200 原尺寸 PNG</strong>，也可导入其他 AI 工具的姿势参考功能。</li><li>电脑端使用 <strong>← / →</strong> 切换角度，<strong>↑ / ↓</strong> 切换姿势；手机端可左右滑动大图。</li></ul>'
  },
  notice: {
    title: '注意事项',
    html: '<ul><li>原作者允许免费用于作品制作，包括商业作品、编辑加工与姿势参考。</li><li><strong>禁止对图片数据本身（原尺寸或加工后）进行再分发、转载或转售。</strong></li><li>署名不是必须的（可自愿标注）。图片元数据已删除，素材按无保证方式提供。</li><li>图中为人体素体线稿，并非真实人物。</li><li>请勿用于真实人物、未成年人相关用途或违反公序良俗的用途。</li></ul><div class="info-note">以上为原站注意事项的中文整理。完整条款以原作者发布内容为准；本镜像的公开展示与转载授权问题，请站点维护者另行确认。</div>'
  }
};

document.querySelectorAll('[data-info]').forEach(button => {
  button.addEventListener('click', () => {
    const info = INFO[button.dataset.info];
    $('#infoTitle').textContent = info.title;
    $('#infoContent').innerHTML = info.html;
    $('#infoDialog').showModal();
  });
});
$('#infoClose').addEventListener('click', () => $('#infoDialog').close());
$('#infoDialog').addEventListener('click', event => { if (event.target === $('#infoDialog')) $('#infoDialog').close(); });

// 普通脚本可从 file:// 读取同目录数据，避免本地双击时 fetch 被浏览器拦截。
function loadLocalData() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'data/pose-zh.js';
    script.onload = () => {
      const data = window.POSE_GALLERY_DATA;
      delete window.POSE_GALLERY_DATA;
      script.remove();
      if (Array.isArray(data)) resolve(data);
      else reject(new Error('本地姿势数据格式不正确'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('无法加载 data/pose-zh.js'));
    };
    document.head.append(script);
  });
}

function loadData() {
  if (location.protocol === 'file:') return loadLocalData();
  return fetch('data/pose-zh.json')
    .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .catch(() => loadLocalData());
}

function loadLocalDescriptions() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => { script.remove(); reject(new Error('姿势描述读取超时')); }, 5000);
    script.src = 'data/pose-descriptions.js';
    script.onload = () => { clearTimeout(timer); script.remove(); resolve(window.POSE_DESCRIPTIONS); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('姿势描述尚未生成')); };
    document.head.append(script);
  });
}

function loadDescriptions() {
  const load = location.protocol === 'file:' ? loadLocalDescriptions() : fetch('data/pose-descriptions.json', { signal: AbortSignal.timeout(5000) })
    .then(response => { if (!response.ok) throw new Error('姿势描述尚未生成'); return response.json(); })
    .catch(() => loadLocalDescriptions());
  return load.then(envelope => {
    if (!envelope || envelope.schema_version !== 1 || !envelope.items || typeof envelope.items !== 'object' || Array.isArray(envelope.items)) return { schema_version: 1, items: {} };
    return envelope;
  }).catch(() => ({ schema_version: 1, items: {} }));
}

Promise.all([loadData(), loadDescriptions()])
  .then(([data, descriptions]) => {
    window.POSE_DESCRIPTIONS = descriptions;
    data.forEach(item => { item.姿势词条 = descriptions.items[item.id] || null; });
    prepareData(data);
    document.dispatchEvent(new CustomEvent('pose-descriptions-ready', { detail: descriptions }));
  })
  .catch(error => {
    console.error(error);
    $('#resultCount').textContent = '图库加载失败';
    grid.innerHTML = '<div class="empty"><h3>无法读取姿势数据</h3><p>请保留完整的 data、thumbs 和 img 文件夹，并将它们与 index.html 放在同一目录后重试。</p><button type="button" onclick="location.reload()">重新加载</button></div>';
  });
})();
