# TECHNICAL.md — 实现细节与踩坑记录

本文记录 glTF Studio 相对上游 `three-gltf-viewer` 的关键技术决策、真实踩过的坑，
以及"怎么验证它真的能跑"的方法。所有结论都来自本机实测，不写没验过的话。

---

## 0. 上游基线

| 项 | 值 |
| --- | --- |
| 仓库 | `donmccurdy/three-gltf-viewer` |
| 版本 | v1.5.1 |
| commit | `b5ee5dafe27f953ae1b55f42b5fa3697fef08683`（2026-10-06） |
| 许可 | MIT / Copyright (c) 2023 Don McCurdy |
| 栈 | Vite 6 + three.js r176 + dat.gui + vhtml（JSX） |
| 源码规模 | `src/` 约 1.3k 行（app 163 / viewer 718 / validator 227） |

上游本身没有测试（`package.json` 里的 `test` 脚本指向不存在的 `test/gen_test.js`）。
所以本次的 19 项端到端断言是**从零建立的回归网**。

---

## 1. 剖切与 stencil 封盖

### 1.1 为什么不用"每个 mesh 一个封盖面"

最直觉的做法：给每个 mesh 配一个封盖平面，`renderer.render()` 单独画一遍。
问题：

- draw call = O(n)，16 个零件就是 16 次整场景渲染；
- 每个封盖都要自己的 stencil 分组，状态切换频繁；
- 实测在 16 个 mesh 上直接掉到 ~8fps。

### 1.2 采用的方案：单封盖 + 增量计数

```
每个 mesh：
  meshBack  (BackSide,  colorWrite=false, stencil += 1)   renderOrder = 10
  meshFront (FrontSide, colorWrite=false, stencil -= 1)   renderOrder = 10

全场景一个：
  capPlane  (MeshStandardMaterial, stencilFunc=NotEqual, ref=0,
             stencilFail/ZFail/ZPass = Replace)            renderOrder = 10.5
             onAfterRender → renderer.clearStencil()
```

封闭实体被平面切开后，视线穿过背面的次数比正面多 1，净 stencil 值 = 1 的像素
正好是被裁掉的实体内部。封盖只在这些像素着色，于是得到实心截面。

### 1.3 四个必须踩的坑

**坑 1：封盖平面不能挂自己的裁剪面**

第一版给封盖也挂了 `clippingPlanes: this.planes`。结果平面正好落在裁剪面上，
被自己裁掉，只剩零散像素。

实测数据（1280×800，读像素统计封盖色）：

| 配置 | 封盖像素 |
| --- | --- |
| 封盖挂 clippingPlanes | 823 |
| 封盖不挂 clippingPlanes | 11,203 |

差 13.6 倍。判据写进了 `verify.mjs` 的「剖切封盖实心填充」断言（阈值 3000）。

**坑 2：stencil 代理不能挂成 mesh 的子节点**

挂成子节点看似能自动继承世界变换，但会继承父级的 `renderOrder` 参与排序，
和模型的透明/不透明分桶混排，累加顺序就乱了。

正确做法：挂 `scene` 下，`matrixAutoUpdate = false`，每帧手动同步：

```js
e.mesh.updateWorldMatrix(true, false);
for (const child of g.children) {
  child.matrixAutoUpdate = false;
  child.matrix.copy(e.mesh.matrixWorld);
  child.matrixWorld.copy(e.mesh.matrixWorld);
  child.matrixWorldNeedsUpdate = false;
}
```

注意：只改组矩阵不够，子 mesh 自己的 `updateMatrixWorld` 会覆盖，必须逐个子节点写。

**坑 3：代理不能关 depthTest**

`depthTest = false` 会让前后零件无差别累加，stencil 溢出成噪点。
官方示例里确实写了 `depthTest = false`，但那个例子只有一个物体。
多物体场景必须开深度测试。

**坑 4：指示面尺寸不能按"最大跨度"**

细长模型（机械臂 1.74×3.35×1.34）如果按最大跨度 ×1.18 做指示面，
会得到一块比模型大得多的板，糊住整个画面。

改为按**该截面上的实际长宽** ×1.02：

```js
const spanX = Math.max(spans[0], 1e-4) * 1.02;
const spanY = Math.max(spans[1], 1e-4) * 1.02;
```

---

## 2. 爆炸视图的父子位移

### 2.1 问题

three.js 里子节点的世界变换 = 父级世界变换 × 局部变换。
如果父子都各自加一份爆炸偏移，子零件会被推**两倍**远，整图散架。

### 2.2 解法：按 depth 升序求差额

```js
// 按 depth 升序，保证父节点先算
const ordered = [...this.nodes].sort((a, b) => a.depth - b.depth);
const accumByNode = new Map();

for (const item of ordered) {
  // 找最近的、也在爆炸列表里的祖先，取它已获得的位移
  let parentAccum = ...; // 沿 parent 链向上找 accumByNode
  const desired = 该零件应有的世界位移;
  const delta = desired - parentAccum;
  // 差额转回父空间（父级可能有旋转）
  delta.applyQuaternion(parent.getWorldQuaternion(q).invert());
  item.node.position.copy(item.base).add(delta);
  accumByNode.set(item.node, desired);
}
```

### 2.3 另一个坑：遇到 mesh 就 return

第一版遍历：

```js
if (node.isMesh) { push(node); return; }  // ← 错
```

装配体常见形态是"父节点自带 mesh，子节点还有 mesh"（base 上装 turret）。
遇到 mesh 就 return，整个子层级全被跳过 —— 实测 16 个零件只识别到 **1 个**。

改为 mesh 也继续下钻，重复叠加问题由上面的差额算法解决。

### 2.4 位移距离要相对包围球

第一版用 `size.length() * 0.42`（对角线 × 0.42），对细长模型过大，零件直接被推出画面。
改为 `radius * 0.55`（包围球半径 × 0.55），尺度稳定。

---

## 3. 标注系统

### 3.1 为什么标签用 DOM 而不是 canvas 贴图

| | DOM | Canvas 贴图 |
| --- | --- | --- |
| 文字清晰度 | 原生，任意 DPR 都锐 | 需要按 DPR 重绘，缩放会糊 |
| 可选中/复制 | ✅ | ✗ |
| 可直接编辑 | ✅ `<input>` | ✗ 要自己做输入框 |
| 无障碍 | ✅ 语义化 | ✗ |
| 成本 | 每条标注 2~3 个 DOM 节点 | 每帧重绘纹理 |

代价是 DOM 节点多时会有布局开销。实测 5 条标注无感；上百条需要改虚拟化。

### 3.2 标签避让

简单重力排布：

1. 按 `side` 分左右两列；
2. 每列按 y 排序，依次下推，保证最小间距 8px；
3. 底部溢出则整体上移；
4. x 方向 clamp 到画面内。

不做力导向（对 5~20 条标注是过度设计）。

### 3.3 遮挡检测的成本控制

每帧对每条标注发一条射线太贵。改为每 6 帧测一次，且只测当前可见的锚点：

```js
this._occFrame = (this._occFrame || 0) + 1;
if (this._occFrame % 6 !== 0) return;
```

副作用：快速旋转时遮挡状态有最多 6 帧延迟（约 100ms）。已写入已知限制。

---

## 4. 取景：为什么要用 setViewOffset

### 4.1 上游的 bug

```js
object.position.x -= center.x;   // 把物体平移到原点
...
this.defaultCamera.position.copy(center);   // 相机却朝原始 center
this.defaultCamera.lookAt(center);
```

物体被移到原点，相机却看原来的 center，模型必然偏出画面。

### 4.2 面板遮挡问题

即使修正了上面，右侧 306px 的面板仍会压住模型。
两种解法：

| 方案 | 问题 |
| --- | --- |
| 平移相机位置 | 相机不再正对模型中心，`OrbitControls` 手感变怪 |
| `camera.setViewOffset()` | 只改投影矩阵的视锥窗口，相机/目标/up 全不变 ✅ |

`setViewOffset(fullW, fullH, offsetX, offsetY, w, h)` 的语义是
"把 `(offsetX, offsetY)` 起的 `w×h` 窗口映射到整个画布"。

- 桌面端（面板在右）：`offsetX = +panelW / 2`
- 移动端（抽屉在下）：`offsetY = +panelH / 2`

**符号踩坑**：第一版写成 `-panelW / 2`，模型被推到更右边。
用像素探针量化确认后改符号：

```
modelBox.centerX = 871px，visibleCenter = 567px   ← 错（-）
modelBox.centerX = 565px，visibleCenter = 567px   ← 对（+），误差 2px
```

### 4.3 有效视口要按两种停靠形态算

```js
const dockRight  = r.width  < fullW * 0.85 && r.height > fullH * 0.6;
const dockBottom = r.height <= fullH * 0.65 && r.width > fullW * 0.85;
```

不区分的话，移动端模型会被抽屉整个盖住（真机验收时实际踩到）。

---

## 5. 修掉的上游 bug

### 5.1 `this.toggleTpl is not a function`（致命）

`src/validator.js:171`：

```js
setReportException(e) {
  this.report = null;
  this.toggleEl.innerHTML = this.toggleTpl({ reportError: e, level: 0 });  // toggleTpl 从未定义
  ...
}
```

`Validator` 类里根本没有 `toggleTpl` 方法。正常路径走 `setReport`，
一旦 validator 抛异常（例如网络受限导致 `gltf-validator` 加载失败），
就二次抛 `TypeError`，**中断整条加载链，模型永远出不来**。

复现条件：`?model=` 指向一个 validator 处理失败的资源。

修复：与成功路径保持一致，直接渲染组件

```js
this.toggleEl.innerHTML = ValidatorToggle({ reportError: e, issues: null });
```

顺带修了 `setReport` 里的参数形状：`ValidatorToggle(report)` → `ValidatorToggle({ issues: report.issues, reportError: null })`，
组件签名是 `({ issues, reportError })`，直接传 report 会让 `issues` 变 undefined。

### 5.2 内嵌贴图加载失败

`src/viewer.js` 的 `setURLModifier`：

```js
const normalizedURL = rootPath + decodeURI(url).replace(baseURL, '').replace(/^(\.?\/)/, '');
```

GLB 内嵌贴图走 `blob:` 协议，被当成相对路径又拼了一次 baseURL，
请求 404，贴图全部丢失。材质带 `alphaTest` 时模型会被切成碎片
（第一版截图里机械臂变成一堆散点就是这个）。

修复：

```js
if (/^(blob:|data:|https?:)/i.test(url)) return url;
```

### 5.3 `?model=` 查询串失效

上游只解析 `location.hash`。补上 `location.search` 并合并（hash 优先）。

### 5.4 面板必须先于模型存在

上游是"载入模型时才创建 Viewer"，导致没载入模型时右侧面板不存在。
改为启动即创建 Viewer + Studio，拖拽区变成半透明浮层。

### 5.5 生产构建缺失静态资源（只在 build 后暴露）

上游 `package.json` 里写了：

```json
"staticFiles": { "staticPath": [{ "staticPath": "assets", "staticOutDir": "assets" }] }
```

这是 `vite-plugin-static-copy` 的配置字段，但**项目并没有安装该插件**。
于是 `npm run build` 产出的 `dist/` 里没有 `assets/`，生产环境下
`?model=/assets/models/xxx.glb` 会命中 SPA fallback 返回 `index.html`，
GLTFLoader 解析 HTML 时抛：

```
SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON
```

dev 模式下 Vite 直接读文件系统，所以这个问题**只在 build 后出现**，
很容易漏测。修复：加 `vite.config.js`，用一个 8 行的内联插件在 `closeBundle` 时
`cpSync` 整个 `assets/`，不额外引依赖。

> 教训：`npm run dev` 通过 ≠ 交付可用。必须对 `dist/` 也跑一遍断言。
> 本项目现在对 dev（5183）和 preview（4173）都跑 19/19。

### 5.6 验收脚本不能依赖开发期模块路径

第一版 `verify.mjs` 用 `await import('/src/studio/project.js')` 直接调序列化函数。
dev 下能跑，build 后该路径不存在（代码已打进 bundle），断言直接崩。

修复：在 `Studio` 构造函数里挂实例方法，测试与 UI 按钮走**同一条代码路径**：

```js
this.serialize = () => serializeProject(this.viewer, this);
this.apply = (data) => applyProject(this.viewer, this, data);
this.capture = (opts) => capturePNG(...);
```

---

## 6. 验证方法

### 6.1 为什么不用"看截图说通过"

开发过程中至少三次出现"截图看着差不多，实际是错的"：

1. 封盖看起来"有橙色"，实际只有 823 个像素的碎屑；
2. 零件树看起来"有内容"，实际只有 3 行（子层级被 return 跳过）；
3. 隔离看起来"生效了"，实际祖先 mesh 全都还亮着。

所以断言一律读**真实状态**，不读像素感受：

| 断言 | 读什么 |
| --- | --- |
| 剖切启用 | `section.entries.length`、`plane.constant`、`plane.normal` |
| 封盖实心 | `gl.readPixels()` 统计封盖色像素数 > 3000 |
| 爆炸生效 | 逐节点 `position.distanceTo(base) > 1e-4` 的计数 |
| 标注投影 | `.anno-dot` 的 `style.transform` 是否被写入 |
| 真实点击 | Playwright `mouse.click()` 打到模型像素，检查标注数 +1 |
| 隔离 | 遍历所有 mesh，检查 `visible` 且 `material.colorWrite !== false` |
| 性能 | 三组对照（基线/静止/拖动），每组 150 帧取 p95 |

### 6.2 性能数据必须绑定环境

同一个页面，两种渲染后端：

| 后端 | 基线 avg | 基线 p95 |
| --- | --- | --- |
| SwiftShader（软件） | 33.2 ms | 95.8 ms |
| ANGLE D3D11 / AMD 780M | 16.67 ms | 18.2 ms |

软件渲染下基线本身就只有 ~30fps，把它的数字当"项目性能"是错的。
`verify.mjs` 会打印实际 GPU 名称，并区分环境判定：

```js
const isSoftware = /swiftshader|llvmpipe|software/i.test(gpuName) || perfBaseline.avg > 25;
```

软件环境只断言"不比基线慢 25%"，硬件环境才断言"p95 < 20ms"。

### 6.3 截图要看"新字节"

读图工具存在缓存串图问题（同字节被判 unchanged）。
`shots.mjs` 每次用不同视口尺寸生成，避免同字节命中缓存。

---

## 7. 示例模型为什么自己造

`assets/models/RoboticArm.glb`（25KB）由 `tools/make_sample.py` 生成。

不直接用 Khronos 官方样例的原因：

1. **网络不可复现**：`AntiqueCamera.glb` 声明 17.5MB，本机下载反复在 1.4–3.2MB 处被掐断，
   拿到的文件是截断的（`declared != actual`），贴图必然加载失败。
   写了 `tools/fetch_models.py` 做断点续传，但对演示来说太重。
2. **演示不出层级**：官方样例多是"一个 mesh 里塞一堆零件"，零件树只有几行，
   爆炸视图也只有 1~2 个位移节点。
3. **可控性**：自建模能精确指定 11 级嵌套、零件命名、4 种材质，
   让「零件树 / 爆炸 / 剖切 / 标注」每个功能都有明确可指的对象。

生成器直接手写 GLB 二进制（JSON chunk + BIN chunk），不依赖任何建模库：

```
glTF header (12B) | JSON chunk (8B header + data) | BIN chunk (8B header + data)
```

顶点数据用 `struct.pack('<3f')` 打包，索引用 `<H`，accessor 的 `min`/`max`
按实际坐标计算（glTF 规范要求 POSITION 必须有 min/max）。

---

## 8. 目录与数据流

```
app.js
  └─ new Viewer()           ← 上游，加了 stencil + 钩子
       └─ new Studio()      ← 新增
            ├─ SectionController   监听 viewer.renderer / viewer.scene
            ├─ ExplodeController   直接改 node.position
            ├─ PartTree            DOM，不碰 three.js
            ├─ AnnotationLayer     投影 → DOM/SVG
            ├─ MeasureController   射线 + Line/Mesh
            └─ project.js          serialize / apply / capturePNG
```

生命周期钩子（在 `viewer.js` 里新增）：

| 钩子 | 时机 | Studio 做什么 |
| --- | --- | --- |
| `onContent(content)` | `setContent` 末尾 | 绑定模型、重建零件树、清空标注 |
| `onClear()` | `clear()` 开头 | 释放克隆材质、stencil 代理 |
| `onFrame()` | 每帧 `render()` 后 | 同步 stencil 矩阵、重排标注/测量标签 |
| `onResize()` | `resize()` 末尾 | 重算 viewOffset、重排叠加层 |

---

## 9. 已知技术债

1. **stencil 代理让 draw call 变成 3 倍**。16 个 mesh 无感；上千 mesh 会明显。
   优化方向：同几何的代理用 `InstancedMesh` 合批，或改用 compute shader 做截面提取。
2. **多平面剖切未实现**。`this.planes` 已是数组，但 UI 和封盖逻辑只支持单平面。
   多平面需要每平面一个 stencil 组 + 一个封盖面（官方示例是 3 个平面 3 组）。
3. **标注没有虚拟化**。上百条标注时 DOM 布局会成为瓶颈。
4. **`getEffectiveViewport()` 每次读 `getBoundingClientRect()`**。
   在 `resize` 里调用没问题，但如果将来每帧调用需要缓存。
5. **没有单元测试**。19 项都是端到端断言，跑一次约 25 秒。
   `explode.js` 的位移数学、`project.js` 的序列化适合补纯函数单测。
