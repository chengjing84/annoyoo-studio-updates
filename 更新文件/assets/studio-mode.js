(() => {
  'use strict';
  const opener = document.getElementById('openStudioSetup');
  if (!opener) return;
  let busy = !document.getElementById('generationJobOverlay').hidden;
  function state() { opener.setAttribute('aria-disabled', String(busy)); opener.title = busy ? '生成结束后可更换安装方式' : '切换使用方式或准备运行环境'; }
  opener.addEventListener('click', event => { if (busy) event.preventDefault(); });
  document.addEventListener('generation-busy-changed', event => { busy = !!event.detail; state(); }); state();
  if (new URLSearchParams(location.search).has('models')) {
    document.getElementById('openLocalEngine')?.click();
    document.getElementById('modelManagerTitle')?.scrollIntoView({ block: 'center' });
    history.replaceState(null, '', location.pathname);
  }
})();
