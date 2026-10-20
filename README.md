# glTF Studio

> 把「模型预览器」升级成「模型拆解与讲解工作台」。
> 基于 [donmccurdy/three-gltf-viewer](https://github.com/donmccurdy/three-gltf-viewer)（MIT）二次开发。

[![Upstream](https://img.shields.io/badge/upstream-donmccurdy%2Fthree--gltf--viewer-blue)](https://github.com/donmccurdy/three-gltf-viewer)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![E2E](https://img.shields.io/badge/e2e-19%2F19%20pass-brightgreen)]()

---

## 1. 为什么做这个

上游 `three-gltf-viewer` 是一个优秀的 **glTF 预览器**：拖进去、转一转、看贴图和动画对不对。
但它的能力边界停在「看」—— 没有剖切、没有爆炸视图、没有零件树、没有标注、没有测量、没有可保存的视图状态。

真实工作中，拿到一个装配体模型后要做的是**讲清楚它**：

| 真实场景 | 上游能不能做 | 本项目 |
| --- | --- | --- |
| 给客户展示内部结构 | ✗ 只能整体转 | ✅ 实时剖切 + 实心封盖 |
| 说明零件装配顺序 | ✗ 看不出层级 | ✅ 爆炸视图（径向 / 轴向） |
| 定位「哪个零件吃性能」 | ✗ 只有 console 打印 | ✅ 零件树 + 三角面数 |
| 给模型写讲解标注 | ✗ 无 | ✅ 3D 锚点 + 2D 标签 + 引导线 |
| 量一下实际尺寸 | ✗ 无 | ✅ 两点测距 + 包围盒 |
| 把「这个视角」交给同事复现 | ✗ 无 | ✅ 项目 JSON 一键还原 |

所以本项目的定位不是「换个皮肤」，而是**在保留上游全部能力的前提下，补上从「看」到「讲」的最后一公里**。

---

## 2. 新增功能

### 2.1 实时剖切（Cross-section）

- **硬件裁剪**：`THREE.Plane` + `material.clippingPlanes`，GPU 端裁片元，不做 CPU 逐面计算。
- **实心封盖**：裸裁剪会留下空心洞。用**模板缓冲增量计数法**补出实心截面：
  - 每个 mesh 生成一对只写 stencil 的代理（`BackSide` +1 / `FrontSide` −1）；
  - 全场景**只需要一个**封盖平面（`stencilFunc = NotEqual, ref = 0`），而不是每个 mesh 一个；
  - 相比「逐 mesh 一个封盖面」省掉 N−1 个 draw call。
- X / Y / Z 三轴 + 反向，位置 0–100% 连续可调，封盖颜色可改。

**踩过的坑（都修了）**：

1. 封盖平面挂了自己的裁剪面 → 平面正好落在裁剪面上被自己裁掉，只剩零散像素。**封盖不能挂 clippingPlanes**。
2. stencil 代理挂成 mesh 的子节点 → 继承父级 renderOrder，与模型的不透明 / 透明分桶混排，累加顺序乱掉。**必须挂 scene 下并每帧同步世界矩阵**。
3. 代理开 `depthTest = false` → 前后零件无差别累加，stencil 溢出成噪点。**必须开深度测试**。
4. 指示面按「最大跨度」放大 → 对细长模型变成一块糊住画面的板。**按截面实际长宽**。

### 2.2 爆炸视图（Exploded view）

- 两种模式：`径向`（从装配体中心炸开）/ `轴向`（沿 X/Y/Z 分层）。
- 缓动驱动（`easeOutBack` 带轻微回弹），可中断、可反向，不依赖第三方动画库。
- **父子位移不叠加**：three.js 里子节点继承父节点位移。若父子各加一份，子零件会被推两倍远、整图散架。实现里按 depth 升序，每个节点只补足「自己应有的世界位移 − 父节点已带走的位移」的差额，并把差额用父级逆四元数转回父空间。
- 只位移不改局部变换基线，关闭时精确还原。

### 2.3 零件树（Hierarchy）

- 层级折叠、显示 / 隐藏、单击选中（包围盒高亮）、双击聚焦、右键隔离。
- 每个 mesh 显示三角面数，快速定位性能大户。
- 搜索过滤（保留命中项及其祖先链）。

### 2.4 3D 标注（Annotations）

- 射线拾取模型表面落点，锚点跟随世界坐标（爆炸 / 剖切后位置自动跟随）。
- 标签用 **DOM** 渲染而非 canvas 贴图：文字清晰、可选中、可无障碍朗读、可直接编辑。
- SVG 折线引导，左右分列 + 简单重力排布自动避让重叠。
- 遮挡检测：被模型挡住时降低不透明度（每 6 帧测一次，控制成本）。

### 2.5 测量（Measure）

- 两点测距，交点**吸附到最近顶点**（阈值内），比「随便点表面」准。
- 数值标签跟随中点投影。
- 同时给出包围盒尺寸与对角线长度。

### 2.6 项目文件（.gltfstudio.json）

相机位姿、剖切参数、爆炸参数、标注、测量、可见性、灯光环境全部序列化。
别人拿到 json + 原模型就能 1:1 复现同一视图 —— 适合评审交付。

### 2.7 截图导出

- 常规 PNG（2000px 宽）
- 透明底 PNG（抠图用）

---

## 3. 顺手修掉的上游 bug

做二次开发时踩到、已修复并有测试覆盖：

| # | 位置 | 问题 | 影响 |
| --- | --- | --- | --- |
| 1 | `src/validator.js` | `setReportException` 调用了**从未定义**的 `this.toggleTpl` | validator 一旦抛异常就二次抛 `TypeError`，中断整条加载链，**模型永远出不来** |
| 2 | `src/viewer.js` | `setURLModifier` 把 `blob:` / `data:` 当相对路径再拼一次 baseURL | GLB 内嵌贴图全部加载失败，材质 `alphaTest` 把模型切成碎片 |
| 3 | `src/viewer.js` | 把物体平移到原点，相机却仍朝**原始 center** 看 | 模型偏出画面 |
| 4 | `src/app.js` | 只解析 `location.hash`，不认 `?model=` | 分享链接失效 |

> 说明：这些是**在本次二次开发的真实运行路径上**暴露并修复的，不是「顺手改改」。每条都在 `TECHNICAL.md` 里记了复现条件。

---

## 4. 快速开始

**在线体验**：https://llinok111.github.io/gltf-studio/

```bash
npm install
npm run dev          # http://localhost:3000
```

打开后可以直接拖入 `.glb` / `.gltf` / 含贴图的 `.zip`，或访问：

```
http://localhost:3000/?model=assets/models/RoboticArm.glb
```

> 注意 `?model=` 后面用的是**相对地址**（没有开头的 `/`）。
> 这样同一份代码在根路径部署和 GitHub Pages 的子路径（`/gltf-studio/`）下都能用。
> 写死 `/assets/...` 只在本机根路径成立，推上 Pages 会 404。

### 生产构建

```bash
npm run build        # 输出到 dist/
npm run preview
```

部署到 GitHub Pages 这类子路径时，必须指定 base：

```bash
# Git Bash 下要加 MSYS_NO_PATHCONV=1，否则 /gltf-studio/ 会被转成本机绝对路径
MSYS_NO_PATHCONV=1 BASE_PATH=/gltf-studio/ npm run build
```

仓库里已配好 `.github/workflows/deploy-pages.yml`，推送到 `main` 会自动构建并发布，
并在发布前校验「产物里没有残留 `/assets/` 这种根路径引用」。

### 运行测试

```bash
# 终端 1
npm run dev

# 终端 2
npm run test:e2e     # 19 项端到端断言，输出截图到 shots/
```

验收脚本接受 `BASE_URL`，可以指向任意部署形态：

```bash
BASE_URL=http://127.0.0.1:4173/ node tools/verify.mjs              # 生产构建
BASE_URL=http://127.0.0.1:4399/gltf-studio/ node tools/verify.mjs  # 模拟 Pages 子路径
```

### 重新生成示例模型

```bash
python tools/make_sample.py
```

`assets/models/RoboticArm.glb`（25KB）由 `tools/make_sample.py` **程序化生成**：11 个零件、11 级真实嵌套、4 种材质，全部几何内嵌、无外链。选它做示例的原因：

- Khronos 官方样例要下 5–17MB，本机网络会中途掐断，不可复现；
- 官方样例多是「一个大 mesh 里塞一堆零件」，零件树 / 爆炸视图演示不出层级。

---

## 5. 操作

| 操作 | 方式 |
| --- | --- |
| 旋转 / 平移 / 缩放 | 左键拖 / 右键拖 / 滚轮 |
| 剖切 | 右侧面板「剖切」→ 选轴 → 拖滑块 |
| 爆炸 | 「爆炸视图」→ 拖滑块 或 点「炸开 / 合拢」 |
| 加标注 | 「＋ 点选模型添加」→ 点模型表面（Esc 取消） |
| 测距 | 「开始测距」→ 点两个表面点 |
| 隔离零件 | 零件树右键，或选中后点「退出隔离」还原 |
| 聚焦零件 | 零件树双击 |
| 保存视图 | 「导出项目 JSON」 |

---

## 6. 效果截图

全部截图由 `npm run shots` 自动生成（`shots/` 目录），非手工摆拍。

| 文件 | 内容 |
| --- | --- |
| `00-landing.png` | 空状态：拖拽区 + 工作台面板（面板在未载入模型时就可用） |
| `01-overview.png` | 整体视图 + 零件树（11 级嵌套、每个 mesh 的面数） |
| `02-section-y.png` | Y 轴剖切 62%：上臂被水平切开，露出橙色实心截面 |
| `03-section-z.png` | Z 轴剖切 52%：底座被切开，看到内部 |
| `04-explode-radial.png` | 径向爆炸 100%：底脚四散、转台与立柱分离 |
| `05-explode-axis.png` | 轴向爆炸（Y）：按高度分层展开 |
| `06-annotations.png` | 5 条标注：锚点 + 标签卡片 + 引导线自动避让 |
| `07-measure.png` | 测距：脚间距 1.360、高度 1.474，右侧显示包围盒 |
| `08-isolate.png` | 隔离上臂组：底座/转台消失，镜头自动聚焦 |
| `09-tablet-1024.png` | 1024×768 右侧面板收窄 |
| `10-tablet-768.png` | 768×1024 面板变底部抽屉 |
| `11-mobile-390.png` | 390×844 抽屉 46vh，模型完整落在抽屉上方 |

---

## 7. 性能

**测试环境**：Windows 11 / Chromium (Playwright) / ANGLE D3D11 / **AMD Radeon 780M**（集显）/ 1440×900 / `devicePixelRatio = 1`。

三组对照（每组 150 帧，取 p50 / p95）：

| 场景 | avg | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| 基线（剖切关闭） | 16.67 ms | 16.60 ms | 18.20 ms | 18.70 ms |
| 剖切开启，静止 | 16.67 ms | 16.70 ms | 18.00 ms | 18.40 ms |
| **剖切拖动（每帧改平面）** | **16.66 ms** | **16.50 ms** | **18.00 ms** | **20.20 ms** |

**结论**：三者都在 16.67ms（60fps 上限）附近，**剖切相对基线的 p95 增量为 −0.2 ~ +1.4ms**，即在集显上基本免费。

> ⚠️ **关于 SwiftShader**：用软件渲染（`--use-angle=swiftshader`）测同一场景时，**基线本身就只有 avg 33ms / p95 96ms**。
> 那不是本项目的开销，是软件光栅化器的上限。所以性能结论必须绑定 GPU 环境，`tools/verify.mjs` 会打印实际 GPU 名称。

**为什么剖切几乎免费**：裁剪在 GPU 片元阶段完成；每帧只改一个 `Plane` 的 normal / constant，不重建材质、不重编译 shader。封盖只多 1 个 draw call。

**已知成本**：stencil 代理让 draw call 数约为原来的 3 倍（每个 mesh 多 2 个 `colorWrite=false` 的代理）。对 16 个 mesh 的装配体无感；对上千 mesh 的超大场景会明显，未来可用 `InstancedMesh` 合批优化。

---

## 8. 响应式

| 断点 | 布局 |
| --- | --- |
| ≥ 1281px | 右侧面板 306px，3D 取景自动扣减面板宽度 |
| 1024–1280px | 右侧面板收窄到 282px |
| 769–900px | 面板变为底部抽屉（52vh），3D 取景扣减抽屉高度 |
| ≤ 768px | 底部抽屉 52vh |
| ≤ 560px | 抽屉压到 46vh，标注卡片缩到 132px，隐藏 footer |

取景用 `camera.setViewOffset()` 在**投影矩阵层面**偏移视锥窗口，而不是平移相机位置 —— 这样相机朝向、up 向量、轨道控制中心都不受影响，拖动手感不会变怪。

---

## 9. 目录结构

```
.
├── index.html                # 入口（新增 studio.css）
├── style.css                 # 上游原样保留
├── studio.css                # 新增：工作台全部样式（含响应式、dat.GUI 皮肤）
├── src/
│   ├── app.js                # 上游 + 挂载 Studio、支持 ?model= 查询串
│   ├── viewer.js             # 上游 + stencil、取景修复、生命周期钩子
│   ├── validator.js          # 上游 + 修 toggleTpl 崩溃
│   ├── environments.js       # 上游原样
│   ├── components/           # 上游原样
│   └── studio/               # ★ 全部新增
│       ├── studio.js         #   编排层 + 面板 UI
│       ├── section.js        #   剖切 + stencil 封盖
│       ├── explode.js        #   爆炸视图
│       ├── tree.js           #   零件树
│       ├── annotations.js    #   3D 标注
│       ├── measure.js        #   测距
│       └── project.js        #   项目序列化 / 截图
├── assets/models/
│   └── RoboticArm.glb        # 程序化生成的示例（25KB）
├── tools/
│   ├── make_sample.py        # 示例模型生成器
│   ├── verify.mjs            # 19 项端到端断言
│   ├── shots.mjs             # 交付截图生成
│   └── fetch_models.py       # 断点续传下载器（备选样例）
├── shots/                    # 效果截图
├── TECHNICAL.md              # 实现细节与踩坑记录
├── NOTICE                    # 上游署名与新增内容清单
└── LICENSE                   # MIT（保留上游版权）
```

---

## 10. 许可证与署名

- 本项目沿用上游 **MIT License**，完整保留 `Copyright (c) 2023 Don McCurdy`。
- 上游来源、commit、新增文件与修改文件清单见 [`NOTICE`](./NOTICE)。
- 示例模型 `RoboticArm.glb` 由本项目脚本生成，声明为 CC0-1.0。

---

## 11. 未做 / 已知限制

诚实列出边界，避免误用：

1. **单平面剖切**。多平面（盒式剖切）需要多个 stencil 组 + 多个封盖面，架构已预留（`this.planes` 是数组），但未实现 UI。
2. **蒙皮网格不做封盖**。`SkinnedMesh` 的封盖在顶点动画下会错位，只做裁剪不做封盖。
3. **测距单位是模型单位**，不做真实世界单位换算（glTF 本身不强制单位语义）。
4. **爆炸视图不处理骨骼动画**。带 animation 的模型爆炸后再播放动画会打架。
5. **标注遮挡检测每 6 帧一次**，快速旋转时会有短暂延迟。
6. **未做 WebGPU 后端**，仍是 WebGL2。
