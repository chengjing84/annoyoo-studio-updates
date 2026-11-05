import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { modelDirectoryMappings } from './local-engine.mjs';

const EXTENSIONS = new Set(['.safetensors', '.ckpt', '.gguf', '.bin', '.pt', '.pth', '.onnx', '.av']);
const SLOTS = { diffusion_models: 'diffusion', text_encoders: 'textEncoder', vae: 'vae', loras: 'loras' };

export async function scanModelDirectories(modelRoot, directories = []) {
  const groups = { diffusion: [], textEncoder: [], vae: [], loras: [] };
  const seen = new Set();
  async function walk(dir, searchRoot, kind) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) return [];
      throw error;
    });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, searchRoot, kind);
      else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        // ComfyUI 使用相对于每个分类搜索根的路径，包含家族子目录。
        const name = path.relative(searchRoot, full);
        const key = `${kind}:${process.platform === 'win32' ? name.toLowerCase() : name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        groups[SLOTS[kind]].push({ name, basename: entry.name, dir, relPath: `${kind}/${name.replaceAll('\\', '/')}`, loraName: name });
      }
    }
  }
  for (const cfg of modelDirectoryMappings([{ path: modelRoot, kinds: [] }, ...directories])) {
    for (const [kind, dirs] of Object.entries(cfg.mappings)) {
      for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
        const searchRoot = path.resolve(cfg.path, dir);
        await walk(searchRoot, searchRoot, kind);
      }
    }
  }
  for (const files of Object.values(groups)) files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return groups;
}

export function resolveModelName(value, names, label) {
  if (!value) return null;
  if (typeof value !== 'string') throw new Error(`${label}名称无效`);
  const normalized = value.replaceAll('\\', '/');
  const exact = names.find(name => name.replaceAll('\\', '/') === normalized);
  if (exact) return exact;
  // 兼容旧版只保存文件名的设置；同名文件必须让用户明确选择。
  const matches = names.filter(name => name.split(/[\\/]/).pop() === normalized);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`${label}存在同名文件，请重新选择包含子目录的模型：${value}`);
  throw new Error(`找不到${label}：${value}，请刷新模型列表后重新选择`);
}
