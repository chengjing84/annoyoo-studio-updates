import { referencePlan, isUpperBodyPose } from './qwen-workflow.mjs';

// Provider-neutral prose. Image numbers follow the exact upload order and are
// ordinary text, rather than model-specific image tokens or a PE instruction.
export function createApiPromptRecord(options) {
  const { pose, costume, poseDescription, prompt, referenceMode, copyCamera, keepBackground } = options;
  const plan = referencePlan(options).map((slot, index) => ({ ...slot, name: `参考图${index + 1}` }));
  const people = plan.filter(slot => slot.role === 'person');
  const poseImage = plan.find(slot => slot.role === 'pose');
  const costumeImage = plan.find(slot => slot.role === 'costume');
  const sceneImage = plan.find(slot => slot.role === 'scene');
  const twoIdentities = referenceMode === 'two-characters';
  const pairPose = !!pose && /^pair/i.test(pose.id);
  const upperBody = isUpperBodyPose(pose);
  const count = twoIdentities || pairPose ? '两位人物' : '一位人物';
  const parts = [`画面中有${count}，采用单一连续场景${upperBody ? '，取景从完整头顶到腰线附近，上身与手势占据主要画幅' : ''}。`];
  if (people[0]) {
    parts.push(`人物A以${people[0].name}为身份参考，保持面容、发型、发色、肤色、体型与整体画风一致。人物设定图中的多个角度表示同一角色，最终画面只呈现一个视角。`);
    if (people[1]) parts.push(twoIdentities
      ? `人物B以${people[1].name}为外貌参考，A与B分别保持各自身份；两人处于同一场景，位置与互动按画面要求安排。`
      : `${people[1].name}补充同一人物另一角度的外貌细节，外貌冲突时以${people[0].name}为准，人物数量保持不变。`);
    if (pairPose && !twoIdentities) parts.push('人物B按画面要求描绘，未指定时采用与A不同的外貌。');
  } else parts.push('人物外貌与画风按画面要求描绘。');
  if (poseImage) {
    parts.push(`${poseImage.name}提供${upperBody ? '头颈、上身和手臂' : '身体'}动作参考：${pose.姿势名称 || ''}。保持四肢位置、支撑点和接触关系，人物有自然连贯的头颈与身体，不呈现素体辅助线或关节标记。`);
    if (poseDescription?.动作描述) parts.push(`动作细节：${poseDescription.动作描述}。遮挡或描述歧义处以参考图可见结构为准。`);
    if (pairPose) parts.push('人物A对应姿势图较前或左侧的人物，人物B对应较后或右侧的人物；动作描述标注A/B时按标注安排，保留承托、接触与前后关系。');
    else if (twoIdentities) parts.push('人物A采用该单人姿势，人物B自然处于旁边，具体互动按画面要求安排。');
    parts.push(copyCamera
      ? `拍摄角度采用${poseImage.name}${pose.角度 ? `的${pose.角度}视角` : '的机位'}。${poseDescription?.视角描述 || ''}`
      : '机位与构图按画面要求设置，姿势图只用于动作参考。');
  } else parts.push(people.length ? '身体动作沿用人物参考，画面要求另有指定时按要求调整。' : '采用自然、清楚展示穿搭的姿态，或按画面要求设置动作。');
  if (costumeImage) {
    parts.push(upperBody
      ? `穿搭采用${costumeImage.name}在上半身可见的衣领、上衣、外套、衣袖、材质、配色和配饰，只呈现半身画幅内可见部分。`
      : `人物实际穿着${costumeImage.name}中的服装、鞋履与配饰，保持款式、剪裁、配色、材质和层次。${costume.中文描述 || costume.服装名称 ? `服装细节：${costume.中文描述 || costume.服装名称}。` : ''}`);
    parts.push('所选服装替换人物参考原有穿搭，布料随动作自然形成褶皱与遮挡；服装展示中的人台、空衣结构和陈列背景不进入画面。');
    if (twoIdentities) parts.push('默认两位人物均采用所选服装，画面要求指定穿着对象时只为对应人物换装。');
  } else if (people.length) parts.push('人物分别沿用各自参考中的穿搭，画面要求另有指定时按要求调整。');
  if (sceneImage) parts.push(`背景、空间与光照采用${sceneImage.name}中的环境，人物融入场景的透视、尺度与接触阴影。该图仅提供环境，图中的路人不增加画面人数。`);
  else if (keepBackground && people[0]) parts.push(`背景与光照沿用${people[0].name}，人物设定表只提供背景色与质感。`);
  else parts.push('背景与光照按画面要求设置，未指定时采用简洁自然的环境。');
  if (prompt) parts.push(`画面要求：${prompt}`);
  if (upperBody) parts.push('保持头顶至腰线的半身取景，完整保留头部与手势，不为展示全套服装或背景而拉远成全身。');
  parts.push(`最终呈现${count}的完整作品，保持人物、衣物与环境的光照和透视一致，不采用参考图拼贴、多视图设定表或服装陈列排版。`);
  const width = options.width ?? 768, height = options.height ?? 1024;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  const ratio = `${width / divisor}:${height / divisor}`;
  parts.push(`目标画幅宽高比为 ${ratio}。`);
  // Keep the record shape shared with the gallery UI; only this prose is sent
  // to the provider. Local ComfyUI continues using its own PE prompt builder.
  return { rewritten_prompt: parts.join(' ').replace(/[\r\n]+/g, ' ').trim(), wh_ratio: ratio, ratio_follow: '' };
}
