(() => {
  'use strict';
  let costumes;
  function loadCostumes() {
    if (!costumes) {
      const request = location.protocol === 'file:' ? new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timer = setTimeout(() => { script.remove(); reject(new Error('服装数据读取超时')); }, 10000);
        script.src = 'data/costume-zh.js';
        script.onload = () => { clearTimeout(timer); script.remove(); resolve(window.COSTUME_DATA); };
        script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('无法读取本地服装数据')); };
        document.head.append(script);
      }) : fetch('data/costume-zh.json', { signal: AbortSignal.timeout(10000) }).then(response => {
        if (!response.ok) throw new Error('无法读取服装数据');
        return response.json();
      });
      costumes = request.then(items => {
        if (!Array.isArray(items)) throw new Error('服装数据格式不正确');
        return items;
      }).catch(error => { costumes = null; throw error; });
    }
    return costumes;
  }
  window.ReferenceLibraryData = Object.freeze({ costumes: loadCostumes });
})();
