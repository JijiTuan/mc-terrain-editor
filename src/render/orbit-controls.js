/**
 * orbit-controls.js — 轨道相机控制（旋转 / 缩放 / 平移）
 *
 * 自己实现而不引入 OrbitControls 的原因：需要与编辑工具共享鼠标事件，
 * 且要支持「左键拖拽 = 旋转视角」与「左键拖拽 = 绘制」的模式切换。
 * 这里只提供相机数学，事件绑定由 interaction 层统一调度。
 *
 * 球坐标：azimuth（水平角）、polar（极角）、distance（距离），target 为注视点。
 */

import * as THREE from 'three'

const EPS = 0.0001

export class OrbitControls {
  constructor(camera, domElement) {
    this.camera = camera
    this.dom = domElement
    this.target = new THREE.Vector3(24, 8, 24)
    this.azimuth = Math.PI * 0.25
    this.polar = Math.PI * 0.32
    this.distance = 70
    this.minDistance = 3
    this.maxDistance = 500
    this.minPolar = 0.05
    this.maxPolar = Math.PI / 2 - 0.02 // 不允许转到地面以下
    this.damping = 0.18
    this.autoRotate = false
    this.autoRotateSpeed = 0.3

    /**
     * WASD 飞行速度（格/秒）。不按距离缩放 —— 用户明确要求「固定步长」：
     * 不管镜头拉多远，同样的按键时长走同样的距离，远距离时不会一下子飞出去。
     */
    this.flySpeed = 14
    /** 按住 Ctrl 时的倍率 */
    this.fastFlyFactor = 4
    /** 由 interaction 层在按住 Ctrl 时置位 */
    this.fastFly = false

    this._targetAz = this.azimuth
    this._targetPolar = this.polar
    this._targetDistance = this.distance
    this._targetTarget = this.target.clone()
    this.update(1)
  }

  setTarget(v) {
    this._targetTarget.copy(v)
  }

  /**
   * 立即对齐：把当前值当作目标值，彻底停住阻尼。
   *
   * 注意参数顺序 —— 调用方若先改 `_targetXxx` 再调 snap()，刚写进去的值会被
   * 这里的 `this.azimuth`（旧值）覆盖回去。需要「设成某个角度并立刻生效」时，
   * 用下面的 `jumpTo()`，别用 snap()。
   */
  snap() {
    this._targetAz = this.azimuth
    this._targetPolar = this.polar
    this._targetDistance = this.distance
    this._targetTarget.copy(this.target)
    this.update(1)
  }

  /**
   * 立即跳到指定姿态（不经过阻尼插值）。
   * 未传的字段保持当前值。加载世界、复位视角这类「必须一次到位」的场景用它。
   */
  jumpTo({ azimuth, polar, distance, target } = {}) {
    if (azimuth !== undefined) this.azimuth = azimuth
    if (polar !== undefined) this.polar = clamp(polar, this.minPolar, this.maxPolar)
    if (distance !== undefined) this.distance = clamp(distance, this.minDistance, this.maxDistance)
    if (target) this.target.copy(target)
    this.snap()
  }

  rotate(dx, dy) {
    this._targetAz -= dx * 0.008
    this._targetPolar -= dy * 0.008
    this._targetPolar = clamp(this._targetPolar, this.minPolar, this.maxPolar)
  }

  zoom(delta) {
    // 指数缩放：无论远近，手感一致
    this._targetDistance *= Math.exp(delta * 0.0012)
    this._targetDistance = clamp(this._targetDistance, this.minDistance, this.maxDistance)
  }

  /**
   * 平移：沿相机的右方向与上方向移动注视点，
   * 移动量按当前距离缩放，保证「屏幕上的拖拽速度」视觉一致。
   */
  pan(dx, dy) {
    const scale = this._targetDistance * 0.0018
    const right = new THREE.Vector3()
    const up = new THREE.Vector3()
    this.camera.matrixWorld.extractBasis(right, up, new THREE.Vector3())
    this._targetTarget.addScaledVector(right, -dx * scale)
    this._targetTarget.addScaledVector(up, dy * scale)
  }

  /**
   * 按视角朝向做「飞行式」平移 —— 对应 WASD 键。
   *
   * 与 pan() 的区别：pan() 是屏幕空间的（沿相机右/上轴，用于鼠标拖拽），
   * 这里是世界空间的水平移动，前方向取相机朝向在水平面上的投影。
   * 这样 W 永远是「朝我正看着的方向前进」，A/D 是左右横移 ——
   * 即 Minecraft 里创造模式飞行的手感。
   *
   * 注视点推着相机一起走，所以观感是「整个人朝那个方向飞过去」，
   * 而不是「相机绕着原地打转」。
   *
   * @param {number} forward 前后分量（W=+1 / S=-1）
   * @param {number} strafe  左右分量（D=+1 / A=-1）
   * @param {number} dt      帧间隔（秒）。传 0 表示不做时间积分（由调用方自行处理）
   */
  fly(forward, strafe, dt) {
    if (!forward && !strafe) return
    if (dt <= 0) return

    // 前方向：相机在世界里的朝向，压平到水平面。
    // 压平是必须的 —— 否则抬头看天按 W 会直接往天上窜。
    const dir = new THREE.Vector3()
    this.camera.getWorldDirection(dir)
    dir.y = 0
    if (dir.lengthSq() < EPS) return // 相机正对天/地，水平方向无定义，忽略这次
    dir.normalize()

    // 右方向 = 前方向绕 Y 轴转 -90°，直接用叉乘世界向上向量得到
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize()

    const step = this.flySpeed * dt * (this.fastFly ? this.fastFlyFactor : 1)
    this._targetTarget
      .addScaledVector(dir, forward * step)
      .addScaledVector(right, strafe * step)
  }

  /**
   * 把注视点拉回世界范围内。
   * WASD 可以一路飞出去，不设边界的话很容易「飞丢了再也找不到地形」。
   */
  clampTargetToWorld(world, pad = 16) {
    if (!world) return
    const t = this._targetTarget
    t.x = clamp(t.x, -pad, world.width + pad)
    t.y = clamp(t.y, -pad, world.height + pad)
    t.z = clamp(t.z, -pad, world.depth + pad)
  }

  /** 把相机移动到能完整看到整个世界的位置 */
  frameWorld(world) {
    const center = new THREE.Vector3(world.width / 2, world.height / 2, world.depth / 2)
    const radius = Math.max(world.width, world.height, world.depth) * 0.75
    // 用 jumpTo 而不是「先写 _targetXxx 再 snap()」：
    // snap() 是拿 this.azimuth（旧值）回填目标的，会把这里算好的角度冲掉，
    // 相机会停在用户上次旋转到的角度上，frameWorld 等于没生效。
    this.jumpTo({
      azimuth: Math.PI * 0.25,
      polar: Math.PI * 0.32,
      distance: clamp(radius / Math.tan((this.camera.fov * Math.PI) / 360) * 1.35, this.minDistance, this.maxDistance),
      target: center,
    })
  }

  update(dt = 1) {
    if (this.autoRotate) this._targetAz += this.autoRotateSpeed * dt * 0.01

    const k = Math.min(1, this.damping * (dt > 0 ? Math.max(dt, 1) : 1))
    this.azimuth += (this._targetAz - this.azimuth) * k
    this.polar += (this._targetPolar - this.polar) * k
    this.distance += (this._targetDistance - this.distance) * k
    this.target.lerp(this._targetTarget, k)

    const sp = Math.sin(this.polar)
    const cp = Math.cos(this.polar)
    this.camera.position.set(
      this.target.x + this.distance * sp * Math.sin(this.azimuth),
      this.target.y + this.distance * cp,
      this.target.z + this.distance * sp * Math.cos(this.azimuth)
    )
    this.camera.lookAt(this.target)
    this.camera.updateMatrixWorld()
  }

  /** 预设视角（顶/前/侧/默认），带阻尼飞到目标位姿 */
  setView(name, world) {
    const c = new THREE.Vector3(world.width / 2, world.height / 2, world.depth / 2)
    // 只写 _targetXxx 不碰 snap()：这里要的是「飞过去」的观感，保留阻尼。
    this._targetTarget.copy(c)
    this._targetDistance = Math.max(world.width, world.height, world.depth) * 1.9
    switch (name) {
      case 'top': this._targetPolar = 0.06; this._targetAz = 0; break
      case 'front': this._targetPolar = Math.PI / 2 - 0.02; this._targetAz = 0; break
      case 'side': this._targetPolar = Math.PI / 2 - 0.02; this._targetAz = Math.PI / 2; break
      default: this._targetPolar = Math.PI * 0.32; this._targetAz = Math.PI * 0.25
    }
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}
