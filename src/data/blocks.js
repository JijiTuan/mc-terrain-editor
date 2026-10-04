/**
 * blocks.js — 方块注册表
 *
 * 数据驱动：新增方块只需在 BLOCK_DEFS 里追加一条。
 * 颜色取 Minecraft 原版贴图的代表色，用于 3D 顶点色渲染与 2D 小地图。
 */

/** @typedef {{ id:number, name:string, label:string, color:number, category:string, transparent?:boolean }} BlockDef */

/** 调色板按此顺序排列，id 即数组下标。0 恒为空气（不可放置）。 */
const BLOCK_DEFS = [
  // ---- 0 空气 ----
  { name: 'air', label: '空气', color: 0x000000, category: 'none', transparent: true },

  // ---- 自然方块 ----
  { name: 'stone', label: '石头', color: 0x7e7e7e, category: 'natural' },
  { name: 'cobblestone', label: '圆石', color: 0x8a8a8a, category: 'natural' },
  { name: 'dirt', label: '泥土', color: 0x8b6b47, category: 'natural' },
  { name: 'grass_block', label: '草方块', color: 0x7cb342, category: 'natural' },
  { name: 'sand', label: '沙子', color: 0xdbd3a0, category: 'natural' },
  { name: 'red_sand', label: '红沙', color: 0xbe7232, category: 'natural' },
  { name: 'gravel', label: '砂砾', color: 0x8a8683, category: 'natural' },
  { name: 'clay', label: '黏土', color: 0xa4a8b8, category: 'natural' },
  { name: 'snow_block', label: '雪块', color: 0xf0fbfb, category: 'natural' },
  { name: 'ice', label: '冰', color: 0x9ad4f5, category: 'natural', transparent: true },
  { name: 'packed_ice', label: '浮冰', color: 0x8fc7f0, category: 'natural' },
  { name: 'sandstone', label: '砂岩', color: 0xd8cd9a, category: 'natural' },
  { name: 'terracotta', label: '陶瓦', color: 0x985c43, category: 'natural' },
  { name: 'obsidian', label: '黑曜石', color: 0x15121c, category: 'natural' },
  { name: 'bedrock', label: '基岩', color: 0x555555, category: 'natural' },
  { name: 'mossy_cobblestone', label: '苔石', color: 0x6a7a55, category: 'natural' },
  { name: 'andesite', label: '安山岩', color: 0x8c8c8c, category: 'natural' },
  { name: 'diorite', label: '闪长岩', color: 0xc9c9c9, category: 'natural' },
  { name: 'granite', label: '花岗岩', color: 0x9b6b5c, category: 'natural' },
  { name: 'deepslate', label: '深板岩', color: 0x4c4c50, category: 'natural' },
  { name: 'tuff', label: '凝灰岩', color: 0x6d6d64, category: 'natural' },
  { name: 'calcite', label: '方解石', color: 0xdfe0dc, category: 'natural' },
  { name: 'netherrack', label: '地狱岩', color: 0x71313a, category: 'natural' },
  { name: 'soul_sand', label: '灵魂沙', color: 0x58433a, category: 'natural' },
  { name: 'magma_block', label: '岩浆块', color: 0x9c4b1e, category: 'natural' },

  // ---- 液体 ----
  { name: 'water', label: '水', color: 0x3f76e4, category: 'liquid', transparent: true },
  { name: 'lava', label: '岩浆', color: 0xea6f1d, category: 'liquid' },

  // ---- 木材 ----
  { name: 'oak_log', label: '橡木原木', color: 0xa0814f, category: 'wood' },
  { name: 'oak_planks', label: '橡木木板', color: 0xb08a4f, category: 'wood' },
  { name: 'spruce_log', label: '云杉原木', color: 0x6a5033, category: 'wood' },
  { name: 'spruce_planks', label: '云杉木板', color: 0x7a5a35, category: 'wood' },
  { name: 'birch_log', label: '白桦原木', color: 0xd7cfbd, category: 'wood' },
  { name: 'birch_planks', label: '白桦木板', color: 0xd7c88f, category: 'wood' },
  { name: 'oak_leaves', label: '橡树树叶', color: 0x4a8f2e, category: 'wood', transparent: true },
  { name: 'spruce_leaves', label: '云杉树叶', color: 0x2f6b33, category: 'wood', transparent: true },
  { name: 'birch_leaves', label: '白桦树叶', color: 0x6aa83a, category: 'wood', transparent: true },

  // ---- 建筑 ----
  { name: 'bricks', label: '砖块', color: 0x96463a, category: 'building' },
  { name: 'stone_bricks', label: '石砖', color: 0x7a7a7a, category: 'building' },
  { name: 'glass', label: '玻璃', color: 0xc8e8f0, category: 'building', transparent: true },
  { name: 'white_concrete', label: '白色混凝土', color: 0xcfd5d6, category: 'building' },
  { name: 'gray_concrete', label: '灰色混凝土', color: 0x7d7d73, category: 'building' },
  { name: 'black_concrete', label: '黑色混凝土', color: 0x1d1d21, category: 'building' },
  { name: 'red_concrete', label: '红色混凝土', color: 0x8e2121, category: 'building' },
  { name: 'blue_concrete', label: '蓝色混凝土', color: 0x2c2e8f, category: 'building' },
  { name: 'yellow_concrete', label: '黄色混凝土', color: 0xf0af15, category: 'building' },
  { name: 'green_concrete', label: '绿色混凝土', color: 0x5e7f31, category: 'building' },
  { name: 'quartz_block', label: '石英块', color: 0xe8e4dc, category: 'building' },

  // ---- 矿石 / 发光 ----
  { name: 'coal_ore', label: '煤矿石', color: 0x6b6b6b, category: 'ore' },
  { name: 'iron_ore', label: '铁矿石', color: 0xa8917e, category: 'ore' },
  { name: 'gold_ore', label: '金矿石', color: 0xc9a24a, category: 'ore' },
  { name: 'diamond_ore', label: '钻石矿石', color: 0x5decd5, category: 'ore' },
  { name: 'redstone_ore', label: '红石矿石', color: 0xa31b1b, category: 'ore' },
  { name: 'glowstone', label: '荧石', color: 0xf0d78a, category: 'ore' },
  { name: 'sea_lantern', label: '海晶灯', color: 0xc7e8e0, category: 'ore' },
]

const blocks = BLOCK_DEFS.map((def, id) => ({
  id,
  transparent: false,
  category: 'building',
  ...def,
}))

/** 名字 → 定义 */
export const BLOCK_BY_NAME = new Map(blocks.map((b) => [b.name, b]))
/** id → 定义 */
export const BLOCK_BY_ID = blocks
/** 可放置方块数量上限（含空气） */
export const BLOCK_COUNT = blocks.length
export const AIR = 0

/** 默认调色板：左侧面板展示的常用方块 */
export const DEFAULT_PALETTE = [
  'stone', 'cobblestone', 'dirt', 'grass_block', 'sand', 'gravel',
  'oak_log', 'oak_planks', 'oak_leaves', 'bricks', 'stone_bricks', 'glass',
  'water', 'lava', 'snow_block', 'ice', 'obsidian', 'glowstone',
]

/** 分类中文名（面板分组用） */
export const CATEGORY_LABELS = {
  natural: '自然',
  liquid: '液体',
  wood: '木材',
  building: '建筑',
  ore: '矿石 / 发光',
}

/**
 * 按名字解析方块 id；未知名字回退到 fallback。
 * 名称容错：支持 "minecraft:stone" 前缀、大小写混写、中文 label。
 */
export function resolveBlockId(name, fallback = 1) {
  if (typeof name === 'number') return name
  if (!name) return fallback
  const raw = String(name).trim().toLowerCase().replace(/^minecraft:/, '')
  if (BLOCK_BY_NAME.has(raw)) return BLOCK_BY_NAME.get(raw).id
  const byLabel = blocks.find((b) => b.label === String(name).trim())
  if (byLabel) return byLabel.id
  return fallback
}

export function blockLabel(id) {
  return BLOCK_BY_ID[id]?.label ?? `#${id}`
}

export default blocks
