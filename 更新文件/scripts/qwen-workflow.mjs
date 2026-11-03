import { randomInt } from 'node:crypto';

export const REQUIRED_NODES = ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoadImage', 'ResizeAndPadImage', 'ImageScaleToMaxDimension', 'TextEncodeQwenImage21', 'QwenImage21Cache', 'KSampler', 'VAEDecode', 'SaveImage'];
export const MAX_LORAS = 8;
const basename = name => String(name).split(/[\\/]/).pop();

export function selectModels(info) {
  const options = (node, field) => info[node]?.input?.required?.[field]?.[0] || [];
  const select = (names, patterns) => {
    for (const pattern of patterns) {
      const matches = names.filter(name => pattern.test(basename(name)));
      const chosen = matches.find(name => /qwen2\.1[\\/]/i.test(name)) || matches[0];
      if (chosen) return chosen;
    }
    return null;
  };
  const model = {
    diffusion: select(options('UNETLoader', 'unet_name'), [/^qwen_image_2\.1_int8_convrot\.safetensors$/i, /^qwen_image_2\.1_bf16\.safetensors$/i]),
    textEncoder: select(options('CLIPLoader', 'clip_name'), [/^qwen3vl_8b_int8_convrot\.safetensors$/i, /^qwen3vl_8b_fp8_scaled\.safetensors$/i, /^qwen3vl_8b_bf16\.safetensors$/i, /^qwen3vl_8b_w4a8\.safetensors$/i]),
    vae: select(options('VAELoader', 'vae_name'), [/^qwen_image_2\.1_vae_bf16\.safetensors$/i])
  };
  const missing = REQUIRED_NODES.filter(name => !info[name]).map(name => `缺少节点：${name}`);
  if (!model.diffusion) missing.push('缺少 Qwen-Image 2.1 标准版模型（不会使用 Turbo 或合并模型替代）');
  if (!model.textEncoder) missing.push('缺少 Qwen3-VL 8B 文本编码器');
  if (!model.vae) missing.push('缺少 Qwen-Image 2.1 VAE');
  return { model, missing };
}

export function selectLoras(info) {
  const node = info.LoraLoaderModelOnly;
  const names = node?.input?.required?.lora_name?.[0];
  return { available: !!node && Array.isArray(names), names: Array.isArray(names) ? names.filter(name => typeof name === 'string') : [], maxCount: MAX_LORAS, strength: { min: -100, max: 100, step: 0.01, default: 1 } };
}

export function validateOptions(body, poses, descriptions, costumes = new Map()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式不正确');
  const pose = body.poseId ? poses.get(body.poseId) : null;
  const costume = body.costumeId ? costumes.get(body.costumeId) : null;
  if (body.poseId && !pose) throw new Error('请选择有效的姿势');
  if (body.costumeId && !costume) throw new Error('请选择有效的服装');
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > 6000) throw new Error('提示词请控制在 6000 字以内');
  const referenceIds = body.referenceIds ?? (body.referenceId ? [body.referenceId] : []);
  if (!Array.isArray(referenceIds) || referenceIds.length > 2 || referenceIds.some(id => typeof id !== 'string' || !id) || new Set(referenceIds).size !== referenceIds.length) throw new Error('最多上传两张不同的参考图');
  const referenceMode = body.referenceMode ?? (referenceIds.length === 2 ? 'two-characters' : 'single-character');
  if (!['single-character', 'same-character', 'two-characters', 'scene'].includes(referenceMode)) throw new Error('第二张参考图用途不正确');
  const inferredRoles = referenceMode === 'scene'
    ? (referenceIds.length === 2 ? ['person1', 'scene'] : referenceIds.length === 1 ? ['scene'] : [])
    : referenceIds.map((_, index) => index === 0 ? 'person1' : referenceMode === 'same-character' ? 'supplement' : 'person2');
  const referenceRoles = body.referenceRoles ?? inferredRoles;
  if (!Array.isArray(referenceRoles) || referenceRoles.length !== referenceIds.length || referenceRoles.some(role => !['person1', 'person2', 'scene', 'supplement'].includes(role))) throw new Error('参考图用途与上传图片不匹配');
  const shape = referenceRoles.join(',');
  const allowed = { 'single-character': ['', 'person1'], 'same-character': ['', 'person1', 'person1,supplement'], 'two-characters': ['person1,person2'], scene: ['scene', 'person1,scene'] };
  if (!allowed[referenceMode].includes(shape)) throw new Error(referenceMode === 'two-characters' ? '两位人物模式需要人物参考1和人物参考2各一张' : '请按所选用途上传人物参考1及第二张参考图');
  const hasPerson = referenceRoles.includes('person1');
  if (!pose && !costume && !(hasPerson && referenceRoles.includes('scene'))) throw new Error('请选择姿势或服装，或上传人物参考1与环境场景图');
  if (!prompt && !hasPerson) throw new Error(referenceRoles.includes('scene') ? '请填写人物描述，或上传人物参考1；环境图不提供人物身份' : '请填写提示词，或上传人物参考1');
  const requestedLoras = body.loras ?? [];
  if (!Array.isArray(requestedLoras) || requestedLoras.length > MAX_LORAS) throw new Error(`LoRA 数量应为 0–${MAX_LORAS} 个`);
  const loras = requestedLoras.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 1024) throw new Error('请选择有效的 LoRA 模型');
    if (typeof item.strength !== 'number' || !Number.isFinite(item.strength) || item.strength < -100 || item.strength > 100) throw new Error('LoRA 权重应为 -100 至 100 之间的数字');
    return { name: item.name, strength: item.strength };
  });
  if (new Set(loras.map(item => item.name)).size !== loras.length) throw new Error('同一 LoRA 请只添加一次');
  const width = body.width ?? 768;
  const height = body.height ?? 1024;
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1536 && n % 32 === 0) || width * height > 1572864) throw new Error('图片尺寸应为 256–1536 范围内的 32 倍数，总像素不超过 150 万');
  const steps = body.steps ?? 30;
  if (!Number.isInteger(steps) || steps < 20 || steps > 50) throw new Error('标准版采样步数应为 20–50');
  let seed = body.seed ?? -1;
  if (seed === -1) seed = randomInt(0, 4294967296);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('种子应为非负安全整数，或用 -1 随机生成');
  return { pose, costume, poseDescription: pose ? descriptions?.get(pose.id) || null : null, prompt, referenceIds, referenceRoles, referenceMode, loras, width, height, steps, seed, copyCamera: !!pose && body.copyCamera !== false, keepBackground: hasPerson && !referenceRoles.includes('scene') && body.keepBackground === true };
}

// Keep the editing canvas, image inputs and prompt tags in the same order.
// Identity references always precede pose guides and garment-only displays.
export function referencePlan(options) {
  const references = (options.referenceIds || []).map((_, index) => ({ role: options.referenceRoles?.[index] === 'scene' ? 'scene' : 'person', index }));
  const people = references.filter(slot => slot.role === 'person');
  const costume = options.costume ? [{ role: 'costume' }] : [];
  const pose = options.pose ? [{ role: 'pose' }] : [];
  return [...people, ...pose, ...costume, ...references.filter(slot => slot.role === 'scene')];
}

export function isUpperBodyPose(pose) {
  return pose?.体系 === '上半身单人' || /^upper80v2_/i.test(pose?.id || '');
}

function upperBodyCostumeDescription(costume) {
  const labels = Array.isArray(costume.关键词) ? costume.关键词 : String(costume.中文描述 || costume.服装名称 || '').split(/[、，,；;·]/);
  return labels.map(label => String(label).trim()).filter(label => {
    if (/连衣裙|连体|长袍|泳衣|套装/.test(label)) return true;
    return !/鞋|靴|袜|半身裙|迷你裙|短裙|百褶裙|长裙|裤|手袋|手提包|单肩包|斜挎包/.test(label);
  }).filter(Boolean).join('、') || '采用服装图在腰线以上可见的穿搭细节';
}

function createUpperBodyInstruction(options, people, poseTag, costumeTag, sceneTag) {
  const { pose, poseDescription, costume, referenceMode, copyCamera, keepBackground, prompt } = options;
  const twoPeople = referenceMode === 'two-characters';
  const count = twoPeople ? '两位人物' : '一位人物';
  const parts = [`生成${count}的上半身中近景人像，采用${poseTag}中的头颈、上身与手臂动作。画面从完整头顶到腰线附近，保留面部、发型和手势，人物上身占据主要画幅。`];
  if (people[0]) parts.push(`${people[0]}是人物A的身份来源，保持面部身份、五官、发型、发色、肤色、上身体型和原有画风一致。人物图即使包含全身、多角度立绘或面部特写，也只提取身份，不沿用其全身构图或设定表排版。`);
  else parts.push('人物面容、发型、上身体型和画风采用用户描述，素体的空白面部与辅助线不出现在结果中。');
  if (people[1]) parts.push(twoPeople
    ? `${people[1]}是人物B的独立身份来源，分别保持A与B的面容、发型及上身特征，不混合身份。两人都采用头顶至腰部的上半身取景，人物A使用所选手势，B自然处于同一构图中。`
    : `${people[1]}是同一人物的补充参考，只补充外貌细节，不增加人数，也不引入全身立绘构图。`);
  parts.push(`${poseTag}属于“上半身单人”姿势，严格保持其半身裁切范围。姿势名称：${pose.姿势名称}。动作只落实在画幅内的头颈、肩胸、躯干与手臂，不补出姿势图裁掉的下半身。`);
  if (poseDescription?.动作描述) parts.push(`上身动作：${poseDescription.动作描述}。保留手指动作与手臂遮挡关系，说明涉及画幅外部位时不向下扩图。`);
  parts.push(copyCamera
    ? `采用${poseTag}的${pose.角度 || ''}机位，取景始终为上半身。${poseDescription?.视角描述 || ''}`
    : '机位方向按用户要求设置；关闭姿势拍摄视角只允许改变机位，不解除上半身取景限制。');
  if (costume) parts.push(`${costumeTag}只提供上半身画幅内可见的穿搭：衣领、上衣、外套、衣袖、材质配色及可见配饰。上身服装描述：${upperBodyCostumeDescription(costume)}。服装参考优先于人物图原有穿着，按图中真实搭配理解重叠标签。仅让可见衣物随手臂与上身姿态自然贴合，不要求展示整件长衣、裙摆或画幅外单品。服装展示中的空领口、隐形人体或陈列背景不进入结果。`);
  else parts.push(twoPeople ? '两位人物分别沿用各自人物图在上身可见的衣着，用户明确指定服装变化时按要求修改可见部分。' : '人物衣着沿用身份参考或用户要求，只描绘半身画幅内可见的部分。');
  parts.push(sceneTag
    ? `${sceneTag}只提供半身近景中可见的背景、空间色彩与光照，不提供人物身份。让人物上身融入环境，不为展示地面、家具或环境全貌拉远镜头；环境图中的路人不增加人物。`
    : keepBackground && people[0] ? `沿用${people[0]}中半身取景范围内的背景与光照，不为保留原场景而扩大全身构图。` : '背景按用户要求或简洁自然环境设置，仅显示半身近景所需的背景。');
  if (prompt) parts.push(`用户画面要求（在上述半身范围内落实）：${prompt}`);
  parts.push(`最终取景限制：只输出${count}从完整头顶至腰部的半身人像，画面下缘在腰线附近，保持头颈与可见上身连贯并留住手势；不出现大腿、膝盖、小腿、脚或鞋，不拉远成全身，不为了展示全套穿搭或参考图中的下半身而扩图。`);
  return parts.join(' ');
}

function sceneInstruction(sceneTag, options) {
  return `${sceneTag}是环境场景参考，只提供空间布局、建筑、地面、家具、光照和环境色彩。将人物自然放入该场景，匹配尺度、透视、光照、接触阴影和地面承托。环境图不提供人物面容、发型、服装或第二位人物，图中的路人和人像不增加输出人数，也不替换已指定角色。${options.pose && options.copyCamera ? '机位以姿势参考为准，调整环境透视适应人物与机位。' : '机位按用户要求设置，未指定时采用环境图的自然观察视角。'}`;
}

function createSceneCharacterInstruction(options, personTag, sceneTag) {
  const parts = [
    `将${personTag}中的人物自然放入${sceneTag}的环境中，生成只有一位完整人物的连续场景。`,
    `${personTag}只提供主角身份、面容、发型、发色、肤色、身体比例、服装和原有画风，保持可识别一致；默认保留原有穿搭与整体动作，用户明确要求变化时按用户要求调整。`,
    '人物图若为多角度设定表，各视图只表示同一个角色，不复制多视图排版或增加人物。保留角色完整头颈与可见四肢。',
    sceneInstruction(sceneTag, options),
    '根据场景的地面、座椅或其他承托面安排人物位置，调整人物尺度、接触阴影和光照，使人物真实处于该空间。'
  ];
  if (options.prompt) parts.push(`用户画面要求：${options.prompt}`);
  return parts.join(' ');
}

function createPosedCharacterInstruction(options, people, poseTag, costumeTag, sceneTag) {
  const { pose, costume, poseDescription, prompt, referenceMode, copyCamera, keepBackground } = options;
  const twoIdentities = referenceMode === 'two-characters';
  const pairPose = /^pair/i.test(pose.id);
  const count = twoIdentities || pairPose ? '两位人物' : '一位人物';
  const parts = [twoIdentities
    ? `将${people[0]}与${people[1]}中的两位角色放入同一连续场景，把身体动作重排为${poseTag}中的姿势${costume ? `，并让角色穿上${costumeTag}中的整套服装` : ''}。`
    : `将${people[0]}中的角色改为${poseTag}中的身体姿势${costume ? `，并换上${costumeTag}中的整套服装` : ''}，生成包含完整头部与身体的${count}画面。`];
  parts.push(`${people[0]}是人物身份来源，保持面部身份、五官、发型、发色、肤色、身体比例和原有画风一致；保留完整头部、脸、头发和颈部，头部与躯干自然连接。身体动作需要按姿势图重新摆放，不固定人物图原来的站姿、手脚位置或取景。`);
  parts.push('人物参考如果是同一角色的正面、侧面、背面或面部特写设定表，各视图只用于识别同一身份。输出单一连续构图，不复制服装设定表、多视图排版、并排立绘或重复人物。');
  if (people[1]) parts.push(twoIdentities
    ? `${people[1]}是人物B的身份来源。人物A只采用${people[0]}的面容、发型、发色、肤色与体型，人物B只采用${people[1]}的对应特征，分别保持各自身份。${!pairPose ? '单人姿势应用于第一位人物，第二位自然站在其旁边。' : `${people[0]}绑定姿势中的人物A，${people[1]}绑定人物B；严格沿用动作描述中的A/B位置与前后、承托、接触关系。未标注A/B时，以较前或左侧身体为A，较后或右侧身体为B。`}`
    : `${people[1]}是同一人物的补充参考，只用于补充另一角度的外貌，冲突时以${people[0]}为准，不按参考图数量增加人物。`);
  parts.push(`${poseTag}只提供身体动作、头部朝向、四肢排列、支撑点和接触关系。将人物的真实头部与身体摆成该动作，素体的空白面部、关节标记和辅助线不进入结果。姿势名称：${pose.姿势名称}；分类：${pose.分类}。`);
  if (poseDescription?.动作描述) parts.push(`动作描述：${poseDescription.动作描述}。描述歧义或遮挡处，以姿势图可见结构为准。`);
  parts.push(copyCamera
    ? `采用${poseTag}的${pose.角度 || ''}视角与取景，保留人物完整头部及该取景内可见身体。${poseDescription?.视角描述 || ''}`
    : '机位、构图采用用户要求，姿势描述中的画面方位只用于说明原动作，不固定最终机位。');
  if (costume) parts.push(`${costumeTag}只提供服装、鞋和配饰的款式、颜色、材质、层次及数量，不能提供人物的身体或头部结构。服装参考优先于人物参考原有的穿着。服装描述：${costume.中文描述 || costume.服装名称}。文字标签作为补充，重叠标签按图中实际搭配理解，细节以服装图为准。替换原衣鞋，使新衣服随人物新姿态形成褶皱与遮挡；不继承服装展示中的无头、隐形人体、空领口或悬空服饰结构。`);
  else parts.push(twoIdentities
    ? `人物穿着分别沿用各自参考：人物A的衣服、鞋与配饰来自${people[0]}，人物B的来自${people[1]}，不能把一人的整套穿搭复制给另一人。用户明确指定服装变化时按用户要求调整。`
    : '人物穿着沿用人物参考，用户明确指定服装变化时按用户要求调整，衣物随新姿态自然贴合。');
  if (pairPose && !twoIdentities) parts.push('双人姿势仍需两位人物：人物A采用已上传人物参考，人物B按用户描述生成；未描述B时生成外观不同的配角，不将补充图或环境图当成人物B，也不复制A的面容。');
  parts.push(`最终画面只有${count}，有可识别的人物面部、完整头颈和与动作一致的身体，人物身份来自人物图，动作来自姿势图${costume ? '，穿搭来自服装图' : ''}；不输出无头人台、空衣陈列、素体线稿或参考图拼贴。`);
  parts.push(sceneTag ? sceneInstruction(sceneTag, options) : keepBackground
    ? `最终场景采用${people[0]}的背景，匹配光照和地面接触；人物图若是角色设定表，只沿用其背景色与质感，不复制设定表布局。`
    : '场景与光照按用户要求设置，未指定时采用简洁自然的环境，人物与衣物的光照、阴影和透视保持一致。');
  if (prompt) parts.push(`用户画面要求：${prompt}`);
  return parts.join(' ');
}

function createTryOnInstruction(options, people, costumeTag, sceneTag) {
  const { costume, prompt, referenceMode, keepBackground } = options;
  const twoPeople = referenceMode === 'two-characters';
  const parts = twoPeople
    ? [`将${people[0]}与${people[1]}中的两位人物合成到同一画面，为两位人物换上${costumeTag}中的整套服装；用户明确指定穿着对象时，只为指定人物换装。以${people[0]}为主画面的风格与透视基础，两张人物图分别提供各自身份。`]
    : [`将${people[0]}中人物的现有穿搭替换为${costumeTag}中的整套服装。以${people[0]}为换装编辑底图，编辑对象是这位人物，主要改变穿着。`];
  parts.push(`${people[0]}提供人物身份、头部、发型、肤色、身体比例及原有画风；保留原图可见的面部与手部细节、手中物品和原有遮挡关系。`);
  if (people[1]) parts.push(twoPeople
    ? `${people[1]}提供人物B的身份、头部、发型、肤色与身体比例。人物A只采用${people[0]}的外貌，人物B只采用${people[1]}的外貌，分别保持，不融合或交换面容与发型。未指定位置时，第一位在左、第二位在右，处于同一连续场景。`
    : `${people[1]}是同一人物的补充参考，只补充另一角度的外貌细节；有冲突时以${people[0]}为准，不因此增加人数或改动底图的姿态。`);
  parts.push(twoPeople
    ? '未指定动作时，沿用各自人物图中的身体动作，调整人物位置与尺度以容纳两人；用户明确指定的动作、机位和构图按用户要求处理。'
    : sceneTag
      ? `未指定动作时，保留${people[0]}中人物的身体姿态、肢体位置与朝向；机位与取景适应环境图，让人物自然处于该空间，用户明确指定动作或构图时按用户要求调整。`
      : `未指定动作、机位和构图时，保留${people[0]}中人物的身体姿态、肢体位置、身体朝向、机位与取景；用户明确指定这些变化时按用户要求调整。`);
  parts.push(`${costumeTag}仅提供服装、鞋和配饰的设计，保留图中可见的款式、剪裁、颜色、材质、长度、层次和配饰数量。服装参考优先于人物参考原有的穿着。服装描述：${costume.中文描述 || costume.服装名称}。文字标签仅作补充，重复或并列的词按图片中的实际搭配理解，细节以服装图为准，不将每个标签额外叠成一件衣物。`);
  parts.push('用户未限定只换某件单品时，替换人物原有的上衣、下装或裙装及鞋履，并穿戴服装参考中的对应配饰；人物原有的衣服与鞋子不属于需要保留的身份特征。');
  parts.push('把衣物真实穿戴到人物身体上，使领口、肩线、袖口、腰线、裙摆与鞋履贴合人物原有体态；布料随身体弯曲产生褶皱，手臂、头发与衣物之间的遮挡、接触阴影及透视连续。');
  parts.push(`最终画面只有${twoPeople ? '两位人物' : '一位人物'}实际穿着新服装，保留人物原有的头颈与可见四肢，保持人物图的摄影或绘制质感。不要复制服装图的无头、空衣、隐形人体展示结构、站姿或陈列背景，不输出服装板或参考图拼贴。`);
  parts.push(sceneTag ? sceneInstruction(sceneTag, options) : keepBackground
    ? `保留${people[0]}的场景、机位、光照与地面接触关系，让换上的服装匹配该环境。`
    : '场景与光照按用户画面要求设置；未指定时采用简洁自然的环境，并使人物与服装的光照、阴影和色温统一。');
  if (prompt) parts.push(`用户画面要求：${prompt}`);
  return parts.join(' ');
}

function createEditingDirective(options) {
  const { pose, costume, poseDescription, prompt, referenceMode, copyCamera, keepBackground } = options;
  const references = referencePlan(options);
  const plan = references.map((slot, index) => ({ ...slot, tag: references.length === 1 ? '图像' : `<image${index + 1}>` }));
  const poseTag = plan.find(slot => slot.role === 'pose')?.tag || '';
  const costumeTag = plan.find(slot => slot.role === 'costume')?.tag || '';
  const sceneTag = plan.find(slot => slot.role === 'scene')?.tag || '';
  const people = plan.filter(slot => slot.role === 'person').map(slot => slot.tag);
  if (isUpperBodyPose(pose)) return createUpperBodyInstruction(options, people, poseTag, costumeTag, sceneTag);
  if (pose && people.length) return createPosedCharacterInstruction(options, people, poseTag, costumeTag, sceneTag);
  if (!pose && costume && people.length) return createTryOnInstruction(options, people, costumeTag, sceneTag);
  if (sceneTag && people.length) return createSceneCharacterInstruction(options, people[0], sceneTag);
  const parts = [pose
    ? `采用${poseTag}中的身体动作，${costume ? `搭配${costumeTag}中的服装，` : ''}按用户描述生成有完整头颈与可见身体的人物画面。`
    : `根据${costumeTag}中的服装设计，生成实际穿着这套服装的人物画面，人物外观与画风采用用户描述。`];
  if (pose) {
    parts.push(`${poseTag} 是姿势参考，仅提供身体动作、四肢排列、支撑点和接触关系，素体辅助线与关节标记不出现在结果中。姿势名称：${pose.姿势名称}；分类：${pose.分类}。`);
    if (poseDescription?.动作描述) parts.push(`动作描述：${poseDescription.动作描述}。描述有歧义或部位被遮挡时，以姿势图可见结构为准。`);
    parts.push(copyCamera ? `采用姿势图的${pose.角度 || ''}视角与取景。${poseDescription?.视角描述 || ''}` : '姿势图的画面方位只用于说明动作；机位、取景和构图采用用户画面要求。');
  } else parts.push('没有姿势参考，按用户要求设置动作和构图；未指定时采用自然、清楚展示服装的姿态。');
  if (costume) parts.push(`${costumeTag} 是服装参考。让最终人物穿着这套服装，保留款式、剪裁、颜色、材质、层次及配饰。服装描述：${costume.中文描述 || costume.服装名称}。服装参考优先于人物参考原有的穿着；服装图中的人物身份、姿势与背景不作为生成要求。`);
  if (people.length) {
    parts.push(`${people[0]} 是人物参考1，提供面容、发型、身体特征与画风。${costume ? '穿着采用服装参考。' : '穿着沿用人物参考或采用用户要求。'}`);
    if (people[1]) parts.push(referenceMode === 'two-characters'
      ? `${people[1]} 是人物参考2，提供第二位人物的面容、发型与身体特征。画面恰好两位人物，分别保持两张人物图的身份，不融合成同一张脸；第一位在左、第二位在右，用户明确指定位置时按用户要求。${costume ? '两位人物均采用所选服装，用户明确指定穿着对象时按用户要求。' : '两位人物分别沿用各自穿着，或按用户要求设置。'}${pose && !/^pair/i.test(pose.id) ? '单人姿势应用于第一位人物，第二位自然站在其旁边。' : ''}`
      : `${people[1]} 是同一人物的补充参考，用于补充另一角度的外貌细节；外观冲突时以人物参考1为准，不能因为有两张参考而增加人数。`);
  } else parts.push('人物外观与画风采用用户描述。');
  const count = referenceMode === 'two-characters' || (pose && /^pair/i.test(pose.id)) ? '两位人物' : '一位人物';
  parts.push(`最终画面只有${count}，不展示参考图拼贴、对照图或服装板。`);
  parts.push(sceneTag ? sceneInstruction(sceneTag, options) : keepBackground && people.length ? `最终场景采用${people[0]}的背景，匹配光照和地面接触。` : '场景与光照采用用户要求，未指定时采用简洁自然的环境。');
  if (prompt) parts.push(`用户画面要求：${prompt}`);
  return parts.join(' ');
}

// This is a local template adapter for the official PE-I2I answer contract,
// not inference through the separately trained PE checkpoint. Every supported
// gallery generation includes at least one image, even without an identity.
export function createInstruction(options) {
  return createEditingDirective(options).replace(/[\r\n]+/g, ' ').trim();
}

export function createPromptRecord(options) {
  const width = options.width ?? 768;
  const height = options.height ?? 1024;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  // The gallery explicitly selects the canvas size; inheriting a reference's
  // aspect ratio here would disagree with ResizeAndPadImage in the actual graph.
  return {
    rewritten_prompt: createInstruction(options),
    wh_ratio: `${width / divisor}:${height / divisor}`,
    ratio_follow: ''
  };
}

export function buildWorkflow({ options, model, poseImage, costumeImage, referenceImages = [], referenceImage }) {
  if (!/^qwen_image_2\.1_(?:int8_convrot|bf16)\.safetensors$/i.test(basename(model.diffusion))) throw new Error('仅允许使用 Qwen-Image 2.1 标准版模型');
  const graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: model.diffusion, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: model.textEncoder, type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: model.vae } },
    '6': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: createPromptRecord(options).rewritten_prompt, negative_prompt: '', resolution: 0 } },
    '7': { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
    '8': { class_type: 'KSampler', inputs: { model: ['7', 0], seed: options.seed, steps: options.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', positive: ['6', 0], negative: ['6', 1], latent_image: ['6', 2], denoise: 1 } },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'pose_gallery/qwen21' } }
  };
  let modelInput = ['1', 0];
  for (const [index, lora] of (options.loras || []).filter(item => item.strength !== 0).entries()) {
    const id = String(100 + index);
    graph[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelInput, lora_name: lora.name, strength_model: lora.strength } };
    modelInput = [id, 0];
  }
  graph['7'].inputs.model = modelInput;
  const peopleImages = referenceImage ? [referenceImage] : referenceImages;
  const images = referencePlan(options).map(slot => slot.role === 'pose' ? poseImage : slot.role === 'costume' ? costumeImage : peopleImages[slot.index]);
  if (!images.length) throw new Error('至少需要一张姿势或服装参考图');
  if (images.some(image => typeof image !== 'string' || !image)) throw new Error('参考图与提示词角色不匹配，请重新上传参考图');
  images.forEach((image, index) => {
    const load = String(11 + index * 2);
    const resize = String(12 + index * 2);
    graph[load] = { class_type: 'LoadImage', inputs: { image } };
    graph[resize] = index === 0
      ? { class_type: 'ResizeAndPadImage', inputs: { image: [load, 0], target_width: options.width, target_height: options.height, padding_color: 'white', interpolation: 'lanczos' } }
      : { class_type: 'ImageScaleToMaxDimension', inputs: { image: [load, 0], upscale_method: 'lanczos', largest_size: 1024 } };
    graph['6'].inputs[`images.image_${index + 1}`] = [resize, 0];
  });
  return graph;
}
