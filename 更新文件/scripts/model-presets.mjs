// ──────────────────────────────────────────────────────────────────────
// 模型家族预设
//   每个家族 = 一个 workflow 模板 + 一组默认 UNet / CLIP / VAE / LoRA
//   match 正则数组按优先级排序，index 0 最先尝试
//   defaults 文件名永远优先于 match 结果
// ──────────────────────────────────────────────────────────────────────

/** @typedef {'diffusion'|'textEncoder'|'vae'} ModelSlot */
const SLOTS = ['diffusion', 'textEncoder', 'vae'];
const SLOT_LABELS = { diffusion: 'UNet 主模型', textEncoder: 'CLIP 文本编码器', vae: 'VAE 解码器' };

/** @type {ModelPreset[]} */
export const MODEL_PRESETS = [
  {
    id: 'qwen21',
    name: 'Qwen-Image 2.1',
    workflow: 'qwen21',
    defaultSteps: 30,
    defaultCfg: 1,
    // LoRA
    defaultLoras: [],
    loraSubdir: 'loras/Qwen',
    // 默认文件名（match 到多个时精确匹配优先）
    defaults: {
      diffusion: 'qwen_image_2.1_int8_convrot.safetensors',
      // ⚠️ 必须用 QWEN3VL 架构！qwen3.5_9b 架构的 tokenizer 不兼容 TextEncodeQwenImage21
      textEncoder: 'qwen3vl_8b_fp8_scaled.safetensors',
      vae: 'qwen_image_2.1_vae_bf16.safetensors',
    },
    // 家族识别正则（按优先级排序）
    match: {
      diffusion: [/qwen_image_2\.1/i, /qwen_image_21/i, /qwen2\.1/i],
      // ⚠️ QWEN3VL 架构优先！QWEN35 架构（qwen3.5_9b）tokenizer 不兼容
      textEncoder: [/qwen3vl_8b/i, /qwen3vl/i],
      vae: [/qwen_image_2\.1_vae/i, /qwen_image_vae/i],
    },
  },
];

// ──────────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────────

/**
 * 扫描到的文件名 → 家族匹配
 * @param {ModelPreset} preset
 * @param {{ diffusion?: string[], textEncoder?: string[], vae?: string[] }} allNames
 * @returns {Record<ModelSlot, MatchResult>}
 */
export function matchPreset(preset, allNames) {
  const result = {};
  for (const slot of SLOTS) {
    const pool = allNames[slot] || [];
    const patterns = preset.match[slot];
    const matched = pool.filter(name => patterns.some(p => p.test(String(name).split(/[\\/]/).pop())));
    const defaultName = preset.defaults?.[slot] || null;
    // 选主优先级：defaults 精确文件名 → matched 第一个 → pool 第一个
    const basename = n => String(n).split(/[\\/]/).pop();
    result[slot] = {
      candidates: matched.length ? matched : pool,
      selected: pool.find(n => basename(n) === defaultName) || matched[0] || pool[0] || null,
      matched: matched.length > 0,
      defaultName,
    };
  }
  return result;
}

/**
 * 汇总某个 preset 缺少哪些 slot（用于设置对话框提示）
 * @returns {{ slot: ModelSlot; slotLabel: string; defaultName: string; hint: string }[]}
 */
export function summarizeMissing(preset, matches) {
  const missing = [];
  for (const slot of SLOTS) {
    const m = matches[slot];
    if (!m?.matched) {
      missing.push({
        slot,
        slotLabel: SLOT_LABELS[slot],
        defaultName: m?.defaultName || preset.defaults?.[slot] || '（未指定默认名）',
        hint: m?.selected
          ? `已有 "${m.selected}" 但未匹配到 ${preset.name} 家族`
          : `目录中尚未扫描到 ${SLOT_LABELS[slot]}`,
      });
    }
  }
  return missing;
}

/**
 * 根据 loraSubdir 从扫描结果里过滤出属于该家族的 LoRA
 * @param {ModelPreset} preset
 * @param {{ relPath?: string }[]} loraGroups
 */
export function findPresetLoras(preset, loraGroups) {
  if (!preset?.loraSubdir || !Array.isArray(loraGroups)) return [];
  const prefix = preset.loraSubdir + '/';
  return loraGroups.filter(f => (f.relPath || '').startsWith(prefix));
}

/**
 * 从候选里按 pattern 选一个默认 LoRA（没 pattern 或没匹配就取排序第一个）
 * @param {{ name?: string }[]} candidates
 * @param {string} pattern 正则字符串
 */
export function pickDefaultLora(candidates, pattern) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
  if (pattern) {
    const re = new RegExp(pattern, 'i');
    const matched = sorted.find(f => re.test(f.name || ''));
    if (matched) return matched.name;
  }
  return sorted[0].name;
}

export function validateModelPreferences(prefs) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(prefs) || prefs.presets !== undefined && !record(prefs.presets)) throw new Error('模型设置格式不正确');
  for (const preset of Object.values(prefs.presets || {})) {
    if (!record(preset)) throw new Error('模型预设格式不正确');
    for (const slot of SLOTS) {
      if (preset[slot] !== undefined && (typeof preset[slot] !== 'string' || preset[slot].length > 1024)) throw new Error('模型文件名格式不正确');
    }
    if (preset.loras !== undefined) {
      if (!Array.isArray(preset.loras)) throw new Error('LoRA 列表格式不正确');
      for (const item of preset.loras) {
        if (!record(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 1024) throw new Error('LoRA 文件名格式不正确');
        if (typeof item.strength !== 'number' || !Number.isFinite(item.strength) || item.strength < -100 || item.strength > 100) throw new Error('LoRA 权重应为 -100 至 100 之间的数字');
      }
      if (new Set(preset.loras.map(item => item.name.replaceAll('\\', '/'))).size !== preset.loras.length) throw new Error('同一 LoRA 请只添加一次');
    }
  }
  return prefs;
}
