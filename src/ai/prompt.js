/**
 * prompt.js — 构造给大模型的系统提示词
 *
 * 提示词直接由 op-schema 渲染生成，因此新增一种 op 时提示词自动同步，
 * 不会出现「模型不知道有 fill 操作」这类漂移。
 */

import { describeSchema } from '../core/op-schema.js'
import { BLOCK_BY_ID } from '../data/blocks.js'

/** 提供给模型的可用方块清单（按分类分组，便于模型选色） */
function blockCatalog() {
  const groups = new Map()
  for (const b of BLOCK_BY_ID) {
    if (b.id === 0) continue
    if (!groups.has(b.category)) groups.set(b.category, [])
    groups.get(b.category).push(`${b.name}(${b.label})`)
  }
  const lines = []
  for (const [cat, names] of groups) {
    lines.push(`  [${cat}] ${names.join(', ')}`)
  }
  return lines.join('\n')
}

/**
 * @param {import('../core/voxel-world.js').VoxelWorld} world
 * @param {{selectedBlock:string, selection:string|null, lastError:string|null}} context
 */
export function buildSystemPrompt(world, context = {}) {
  const sel = context.selection
  const selText = sel
    ? `当前已有选区：从 (${sel.x1}, ${sel.y1}, ${sel.z1}) 到 (${sel.x2}, ${sel.y2}, ${sel.z2})。用户说"这片区域""这里"时指的是这个选区。`
    : '当前没有选区。用户提到"这片区域""这里"但你又无法从上下文确定范围时，请自行选择一个合理的范围并把范围写进操作里，同时在 reply 里说明你选了哪片区域。'

  return `你是一个 Minecraft 地形编辑器的指令解析器。用户的自然语言需求要被你翻译成结构化的体素编辑操作。

## 世界信息
世界尺寸：X 0~${world.width - 1}（宽 ${world.width}），Y 0~${world.height - 1}（高 ${world.height}，Y=0 是最底层），Z 0~${world.depth - 1}（深 ${world.depth}）。
坐标系与 Minecraft 一致：X 向东，Y 向上，Z 向南。
当前选中方块：${context.selectedBlock ?? 'stone'}。
${selText}
${context.lastError ? `\n注意：上一次执行失败，原因是「${context.lastError}」。请修正后重新输出。\n` : ''}
## 可用操作
每条操作是一个 JSON 对象。所有坐标必须是整数且落在世界范围内。
${describeSchema()}

## 可用方块名
必须使用下列名字（不要用 "minecraft:" 前缀，也不要用未列出的方块）：
${blockCatalog()}

## 输出格式
只输出一个 JSON 对象，不要有任何解释文字、不要用 markdown 代码块包裹：
{
  "reply": "用中文向用户简述你做了什么，1~3 句，可以包含地形特征、用到的方块、大致坐标范围",
  "ops": [ { "type": "...", ... }, ... ]
}

## 规则
1. 坐标必须是整数，且在世界范围内，否则会被拒绝。
2. 一次最多 64 条操作。op 按顺序执行，后面的可以依赖前面已生成的地形。
3. 需要"山谷中的河"这类效果时：先 terrain 生成山地，再 river 挖河（river 会自动采样地形高度，你不需要算高度）。
4. 用户没给出明确范围时，选一个占据世界大部分面积的合理范围，并在 reply 里说明。
5. 用户描述的是风格/氛围而非具体方块时，自己选择合适的方块组合。
6. 尽量用少量 op 表达意图：区域填充用 fill，地形用 terrain，不要拆成几百条 fill。
7. 如果用户的请求和地形编辑无关（闲聊、问你的身份、询问编辑器用法），返回 ops: [] 并在 reply 里正常回答。
8. 如果用户的请求无法用现有 op 表达，返回 ops: [] 并在 reply 里说明限制，给出一个可行的替代方案。
9. 不要编造不存在的 op 类型或参数名。`
}

/** 组装发给模型的消息数组（含多轮历史） */
export function buildMessages(world, history, userInput, context) {
  const messages = [{ role: 'system', content: buildSystemPrompt(world, context) }]
  // 只保留最近若干轮，避免上下文过长
  const recent = history.slice(-10)
  for (const m of recent) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content })
    }
  }
  messages.push({ role: 'user', content: userInput })
  return messages
}

/** 面向用户的示例提示（输入框上方的快捷标签） */
export const EXAMPLE_PROMPTS = [
  '生成一片山地，并在山谷中挖出一条河',
  '把整个世界铺成草原，地表长草，往下三层是泥土',
  '在中心建一座 12 格半径的圆形石塔，塔身用石砖',
  '给现有的山地上撒一些树，密度大约 3%',
  '在 (10, 10) 到 (40, 40) 挖一个大坑，坑里灌满水',
]
