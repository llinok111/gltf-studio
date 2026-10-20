/**
 * studio.js — 工作台编排层
 *
 * 职责：把 Section / Explode / PartTree / Annotation / Measure 五个新模块
 * 与上游 Viewer 的生命周期（load → setContent → clear）绑起来，并负责所有面板 UI。
 *
 * 设计原则：
 * - 不改上游 Viewer 的既有行为（dat.GUI 面板、validator、动画、morph 全部保留）。
 * - 所有新增状态都挂在 studio 上，模型重载时整体重建，不残留。
 * - 面板可折叠，窄屏自动变为抽屉，保证 390px 宽度下仍可操作。
 */
import { Box3, Sphere, Vector3 } from 'three';

import { SectionController } from './section.js';
import { ExplodeController } from './explode.js';
import { PartTree } from './tree.js';
import { AnnotationLayer } from './annotations.js';
import { MeasureController, formatDistance } from './measure.js';
import { serializeProject, applyProject, capturePNG, download } from './project.js';

export class Studio {
	/**
	 * @param {import('../viewer.js').Viewer} viewer
	 * @param {HTMLElement} viewerEl canvas 容器
	 */
	constructor(viewer, viewerEl) {
		this.viewer = viewer;
		this.viewerEl = viewerEl;
		this.modelName = null;
		this.hiddenNodes = [];
		this.origVisibility = new Map();

		// 叠加层（标注/测量标签都挂在这里）
		this.overlay = document.createElement('div');
		this.overlay.className = 'studio-overlay';
		viewerEl.appendChild(this.overlay);

		this.section = new SectionController(viewer.renderer, viewer.scene);
		this.explode = new ExplodeController(null);
		this.annotations = new AnnotationLayer(this.overlay, viewer.defaultCamera, viewer.scene);
		this.measure = new MeasureController(this.overlay, viewer.defaultCamera, viewer.scene);

		this.buildUI();
		this.bindGlobalEvents();

		// 暴露给外部脚本 / 控制台调试（打包后模块路径不可用，
		// 所以把序列化能力挂到实例上，供 e2e 断言复用同一条代码路径）
		this.serialize = () => serializeProject(this.viewer, this);
		this.apply = (data) => applyProject(this.viewer, this, data);
		this.capture = (opts) =>
			capturePNG(this.viewer.renderer, this.viewer.scene, this.viewer.activeCamera, opts);
	}

	/* ------------------------------------------------------------------ UI */

	buildUI() {
		const panel = (this.panel = document.createElement('aside'));
		panel.className = 'studio-panel';
		panel.setAttribute('aria-label', '模型工作台');
		panel.innerHTML = `
			<div class="sp-head">
				<div class="sp-brand">
					<span class="sp-logo">◈</span>
					<span class="sp-title">glTF Studio</span>
				</div>
				<button class="sp-collapse" type="button" title="折叠面板" aria-label="collapse panel">⟨</button>
			</div>
			<div class="sp-body">
				<section class="sp-sec" data-open="1">
					<h3 class="sp-h">剖切 <span class="sp-hint">Section</span></h3>
					<div class="sp-content">
						<div class="sp-row">
							<label class="sp-switch">
								<input type="checkbox" id="sec-enabled" />
								<span class="sp-track"></span>
								<span class="sp-switch-label">启用剖切</span>
							</label>
						</div>
						<div class="sp-row sp-axis" role="group" aria-label="剖切轴">
							<button type="button" data-axis="x" class="is-on">X</button>
							<button type="button" data-axis="y">Y</button>
							<button type="button" data-axis="z">Z</button>
							<button type="button" data-flip="1" class="sp-flip" title="反转方向">⇄</button>
						</div>
						<div class="sp-row">
							<input type="range" id="sec-pos" min="0" max="1" step="0.001" value="0.5" aria-label="剖切位置" />
							<output id="sec-pos-out">50%</output>
						</div>
						<div class="sp-row sp-checks">
							<label><input type="checkbox" id="sec-cap" checked /> 封盖</label>
							<label><input type="checkbox" id="sec-plane" checked /> 平面指示</label>
						</div>
						<div class="sp-row sp-inline">
							<span class="sp-k">封盖色</span>
							<input type="color" id="sec-cap-color" value="#ff7a45" aria-label="封盖颜色" />
						</div>
					</div>
				</section>

				<section class="sp-sec" data-open="1">
					<h3 class="sp-h">爆炸视图 <span class="sp-hint">Explode</span></h3>
					<div class="sp-content">
						<div class="sp-row sp-axis" role="group" aria-label="爆炸模式">
							<button type="button" data-emode="radial" class="is-on">径向</button>
							<button type="button" data-emode="axis">轴向</button>
						</div>
						<div class="sp-row sp-axis sp-eaxis" role="group" aria-label="爆炸轴" hidden>
							<button type="button" data-eaxis="x">X</button>
							<button type="button" data-eaxis="y" class="is-on">Y</button>
							<button type="button" data-eaxis="z">Z</button>
						</div>
						<div class="sp-row">
							<input type="range" id="exp-amt" min="0" max="1" step="0.005" value="0" aria-label="爆炸程度" />
							<output id="exp-amt-out">0%</output>
						</div>
						<div class="sp-row sp-btns">
							<button type="button" id="exp-toggle" class="sp-btn">炸开 / 合拢</button>
						</div>
						<div class="sp-row sp-checks">
							<label><input type="checkbox" id="exp-top" /> 仅顶层节点</label>
						</div>
					</div>
				</section>

				<section class="sp-sec" data-open="1">
					<h3 class="sp-h">标注 <span class="sp-hint">Annotations</span></h3>
					<div class="sp-content">
						<div class="sp-row sp-btns">
							<button type="button" id="anno-add" class="sp-btn sp-btn-accent">＋ 点选模型添加</button>
							<button type="button" id="anno-clear" class="sp-btn sp-btn-ghost">清空</button>
						</div>
						<p class="sp-tip" id="anno-tip">进入点选模式后，点击模型表面放置标注。</p>
					</div>
				</section>

				<section class="sp-sec" data-open="0">
					<h3 class="sp-h">测量 <span class="sp-hint">Measure</span></h3>
					<div class="sp-content">
						<div class="sp-row sp-btns">
							<button type="button" id="meas-add" class="sp-btn">开始测距</button>
							<button type="button" id="meas-undo" class="sp-btn sp-btn-ghost">撤销</button>
							<button type="button" id="meas-clear" class="sp-btn sp-btn-ghost">清空</button>
						</div>
						<div class="sp-bbox" id="meas-bbox">—</div>
					</div>
				</section>

				<section class="sp-sec" data-open="0">
					<h3 class="sp-h">零件树 <span class="sp-hint">Hierarchy</span></h3>
					<div class="sp-content">
						<div class="sp-row">
							<input type="search" id="tree-filter" placeholder="搜索零件名…" aria-label="搜索零件" />
						</div>
						<div class="sp-row sp-btns">
							<button type="button" id="tree-showall" class="sp-btn sp-btn-ghost">全部显示</button>
							<button type="button" id="tree-isolate" class="sp-btn sp-btn-ghost">退出隔离</button>
						</div>
						<div class="ptree" id="ptree"></div>
					</div>
				</section>

				<section class="sp-sec" data-open="0">
					<h3 class="sp-h">导出 <span class="sp-hint">Export</span></h3>
					<div class="sp-content">
						<div class="sp-row sp-btns sp-stack">
							<button type="button" id="exp-png" class="sp-btn">保存截图 PNG</button>
							<button type="button" id="exp-png-alpha" class="sp-btn sp-btn-ghost">保存透明底 PNG</button>
							<button type="button" id="exp-proj" class="sp-btn sp-btn-ghost">导出项目 JSON</button>
							<label class="sp-btn sp-btn-ghost sp-file">载入项目 JSON
								<input type="file" id="imp-proj" accept=".json,application/json" />
							</label>
						</div>
						<p class="sp-tip">项目文件记录相机、剖切、爆炸、标注与测量，可 1:1 复现视图。</p>
					</div>
				</section>
			</div>
		`;
		document.body.appendChild(panel);

		// 折叠
		panel.querySelector('.sp-collapse').addEventListener('click', () => {
			const collapsed = panel.classList.toggle('is-collapsed');
			panel.querySelector('.sp-collapse').textContent = collapsed ? '⟩' : '⟨';
			this.annotations.layout();
			this.measure.layout();
		});

		// 折叠区块
		panel.querySelectorAll('.sp-sec').forEach((sec) => {
			const h = sec.querySelector('.sp-h');
			h.addEventListener('click', () => {
				const open = sec.getAttribute('data-open') === '1';
				sec.setAttribute('data-open', open ? '0' : '1');
			});
		});

		this.partTree = new PartTree(panel.querySelector('#ptree'), {
			onSelect: (node) => this.highlightNode(node),
			onVisibility: () => this.partTree.syncVisibility(),
			onIsolate: (node) => this.isolate(node),
			onFrame: (node) => this.frameNode(node),
		});

		this.bindControls(panel);
	}

	bindControls(panel) {
		const $ = (sel) => panel.querySelector(sel);

		// 剖切
		$('#sec-enabled').addEventListener('change', (e) => {
			this.section.setEnabled(e.target.checked);
		});
		panel.querySelectorAll('[data-axis]').forEach((btn) => {
			btn.addEventListener('click', () => {
				panel.querySelectorAll('[data-axis]').forEach((b) => b.classList.remove('is-on'));
				btn.classList.add('is-on');
				this.section.setAxis(btn.dataset.axis);
			});
		});
		panel.querySelector('[data-flip]').addEventListener('click', (e) => {
			const on = e.currentTarget.classList.toggle('is-on');
			this.section.setFlip(on);
		});
		$('#sec-pos').addEventListener('input', (e) => {
			const v = Number(e.target.value);
			this.section.setPosition(v);
			$('#sec-pos-out').textContent = Math.round(v * 100) + '%';
		});
		$('#sec-cap').addEventListener('change', (e) => this.section.setCapVisible(e.target.checked));
		$('#sec-plane').addEventListener('change', (e) => this.section.setPlaneVisible(e.target.checked));
		$('#sec-cap-color').addEventListener('input', (e) => this.section.setCapColor(e.target.value));

		// 爆炸
		panel.querySelectorAll('[data-emode]').forEach((btn) => {
			btn.addEventListener('click', () => {
				panel.querySelectorAll('[data-emode]').forEach((b) => b.classList.remove('is-on'));
				btn.classList.add('is-on');
				const mode = btn.dataset.emode;
				this.explode.setMode(mode);
				panel.querySelector('.sp-eaxis').hidden = mode !== 'axis';
			});
		});
		panel.querySelectorAll('[data-eaxis]').forEach((btn) => {
			btn.addEventListener('click', () => {
				panel.querySelectorAll('[data-eaxis]').forEach((b) => b.classList.remove('is-on'));
				btn.classList.add('is-on');
				this.explode.setAxis(btn.dataset.eaxis);
			});
		});
		const amt = $('#exp-amt');
		amt.addEventListener('input', (e) => {
			const v = Number(e.target.value);
			this.explode.setAmount(v);
			$('#exp-amt-out').textContent = Math.round(v * 100) + '%';
		});
		$('#exp-toggle').addEventListener('click', () => this.explode.toggle());
		$('#exp-top').addEventListener('change', (e) => this.explode.setTopLevelOnly(e.target.checked));

		this.explode.onChange((v) => {
			amt.value = String(v);
			$('#exp-amt-out').textContent = Math.round(v * 100) + '%';
			// 爆炸展开后包围体变大，视野要跟着放宽，否则零件飞出画面
			this.adaptFraming(v);
		});

		// 标注
		$('#anno-add').addEventListener('click', () => {
			this.annotations.beginPick((point, node) => {
				this.annotations.add({
					point,
					title: node && node.name ? node.name : 'Part',
					body: '',
					node,
				});
				this.updateAnnoTip();
			});
			this.updateAnnoTip(true);
		});
		$('#anno-clear').addEventListener('click', () => {
			this.annotations.clear();
			this.updateAnnoTip();
		});

		// 测量
		$('#meas-add').addEventListener('click', () => {
			if (this.measure.active) {
				this.measure.cancel();
			} else {
				this.annotations.cancelPick();
				this.measure.begin();
			}
			this.updateMeasureBtn();
		});
		$('#meas-undo').addEventListener('click', () => this.measure.removeLast());
		$('#meas-clear').addEventListener('click', () => this.measure.clear());

		// 树
		$('#tree-filter').addEventListener('input', (e) => this.partTree.setFilter(e.target.value));
		$('#tree-showall').addEventListener('click', () => this.showAll());
		$('#tree-isolate').addEventListener('click', () => this.showAll());

		// 导出
		$('#exp-png').addEventListener('click', () => this.exportPNG(false));
		$('#exp-png-alpha').addEventListener('click', () => this.exportPNG(true));
		$('#exp-proj').addEventListener('click', () => {
			const data = serializeProject(this.viewer, this);
			download(
				(this.modelName || 'scene') + '.gltfstudio.json',
				JSON.stringify(data, null, 2),
				'application/json',
			);
		});
		$('#imp-proj').addEventListener('change', async (e) => {
			const file = e.target.files && e.target.files[0];
			if (!file) return;
			try {
				const text = await file.text();
				applyProject(this.viewer, this, JSON.parse(text));
				this.syncUIFromState();
			} catch (err) {
				window.alert('项目载入失败：' + err.message);
			}
			e.target.value = '';
		});
	}

	/** 面板 UI 跟随程序化修改（载入项目时）回填 */
	syncUIFromState() {
		const panel = this.panel;
		const $ = (s) => panel.querySelector(s);
		$('#sec-enabled').checked = this.section.enabled;
		panel.querySelectorAll('[data-axis]').forEach((b) => {
			b.classList.toggle('is-on', b.dataset.axis === this.section.axis);
		});
		$('#sec-pos').value = String(this.section.position);
		$('#sec-pos-out').textContent = Math.round(this.section.position * 100) + '%';
		$('#sec-cap').checked = this.section.showCap;
		$('#sec-plane').checked = this.section.showPlane;
		$('#sec-cap-color').value = '#' + this.section.capColor.getHexString();

		panel.querySelectorAll('[data-emode]').forEach((b) => {
			b.classList.toggle('is-on', b.dataset.emode === this.explode.mode);
		});
		panel.querySelector('.sp-eaxis').hidden = this.explode.mode !== 'axis';
		$('#exp-amt').value = String(this.explode.amount);
		$('#exp-amt-out').textContent = Math.round(this.explode.amount * 100) + '%';
		$('#exp-top').checked = this.explode.topLevelOnly;

		this.partTree.syncVisibility();
		this.annotations.layout();
		this.measure.layout();
	}

	updateAnnoTip(picking = false) {
		const tip = this.panel.querySelector('#anno-tip');
		tip.textContent = picking
			? '点选中：在模型表面点击放置（Esc 取消）'
			: '进入点选模式后，点击模型表面放置标注。';
		tip.classList.toggle('is-active', picking);
	}

	updateMeasureBtn() {
		const btn = this.panel.querySelector('#meas-add');
		btn.textContent = this.measure.active ? '退出测距 (Esc)' : '开始测距';
		btn.classList.toggle('is-on', this.measure.active);
	}

	/* ------------------------------------------------------------------ 生命周期 */

	/**
	 * 模型加载完成后调用。
	 * @param {import('three').Object3D} content
	 * @param {string} name
	 */
	attach(content, name) {
		this.modelName = name || 'model';
		this.hiddenNodes = [];
		this.origVisibility.clear();

		this.section.setContent(content);
		this.explode.setContent(content);
		this.partTree.setContent(content);
		this.annotations.clear();
		this.measure.clear();

		this.updateBBoxInfo(content);

		// 记录初始取景距离，供爆炸视图按展开程度平滑拉远
		const cam = this.viewer.defaultCamera;
		const ctrl = this.viewer.controls;
		this._framingBase = {
			dist: cam.position.distanceTo(ctrl.target) || 1,
		};

		// 默认关闭剖切，但面板可见
		this.section.setEnabled(false);
		this.panel.querySelector('#sec-enabled').checked = false;
	}

	detach() {
		this.section.disposeContent();
		this.explode.dispose();
		this.annotations.clear();
		this.measure.clear();
		this.partTree.setContent(null);
	}

	updateBBoxInfo(content) {
		const box = new Box3().setFromObject(content);
		const size = box.getSize(new Vector3());
		const el = this.panel.querySelector('#meas-bbox');
		el.innerHTML = `
			<div class="sp-bbox-row"><span>尺寸</span><b>${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)}</b></div>
			<div class="sp-bbox-row"><span>对角线</span><b>${formatDistance(size.length())}</b></div>
		`;
	}

	/**
	 * 爆炸展开时按展开程度把相机沿视线方向后退，保证零件不出画。
	 *
	 * 只改相机到目标的距离，不改朝向 —— 用户的视角角度不会被重置，
	 * 拖着爆炸滑块时画面是平滑"拉远"而不是跳一下。
	 */
	adaptFraming(amount) {
		if (!this.viewer.content) return;
		const cam = this.viewer.defaultCamera;
		const ctrl = this.viewer.controls;
		const base = this._framingBase;
		if (!base) return;

		// amount 从 0→1，距离从基准的 1 倍放大到 1.55 倍
		const target = base.dist * (1 + 0.55 * Math.max(0, Math.min(1, amount)));
		const dir = new Vector3().subVectors(cam.position, ctrl.target).normalize();
		cam.position.copy(ctrl.target).addScaledVector(dir, target);
		ctrl.update();
	}

	/* ------------------------------------------------------------------ 交互 */

	bindGlobalEvents() {
		const canvas = this.viewer.renderer.domElement;

		// 点击：先给测距，再给标注
		canvas.addEventListener('pointerdown', (ev) => {
			if (ev.button !== 0) return;
			this._downX = ev.clientX;
			this._downY = ev.clientY;
		});

		canvas.addEventListener('pointerup', (ev) => {
			if (ev.button !== 0) return;
			// 拖动视角时不触发放置
			const dx = Math.abs(ev.clientX - (this._downX || 0));
			const dy = Math.abs(ev.clientY - (this._downY || 0));
			if (dx + dy > 5) return;
			if (!this.viewer.content) return;

			if (this.measure.handleClick(ev, this.viewer.content)) return;
			if (this.annotations.handleClick(ev, this.viewer.content)) {
				this.updateAnnoTip(false);
				return;
			}
		});

		window.addEventListener('keydown', (ev) => {
			if (ev.key === 'Escape') {
				this.annotations.cancelPick();
				this.measure.cancel();
				this.updateAnnoTip(false);
				this.updateMeasureBtn();
			}
		});

		// 视图变化时重排叠加层
		this.viewer.controls.addEventListener('change', () => {
			this.annotations.layout();
			this.measure.layout();
		});
	}

	/** 每帧调用 */
	update() {
		// 剖切的 stencil 代理挂在 scene 下，需要每帧跟随模型世界矩阵
		this.section.syncStencilTransforms();
		this.annotations.layout();
		this.measure.layout();
	}

	/* ------------------------------------------------------------------ 树操作 */

	highlightNode(node) {
		// 简单高亮：把选中节点包围盒用线框画出
		if (this._hlBox) {
			this.viewer.scene.remove(this._hlBox);
			this._hlBox.geometry.dispose();
			this._hlBox.material.dispose();
			this._hlBox = null;
		}
		if (!node) return;
		const box = new Box3().setFromObject(node);
		if (box.isEmpty()) return;
		const { Box3Helper } = window.THREE || {};
		if (!Box3Helper) return;
		this._hlBox = new Box3Helper(box, 0x5aa9ff);
		this._hlBox.userData.__internal = true;
		this.viewer.scene.add(this._hlBox);
	}

	/**
	 * 隔离：只显示目标节点及其子树。
	 *
	 * 这里有个容易踩的坑：为了不让父级隐藏连带隐藏子级，必须让祖先链保持
	 * "可遍历"，但祖先本身往往**也是 mesh**（如 base/turret/column 都是带
	 * 几何的零件）。如果直接把祖先设为 visible=true，隔离就变成了"整机可见"。
	 *
	 * 正确做法：用两层控制 ——
	 *   · 祖先：visible=true 但把它的 material 换成完全透明的"幽灵材质"，
	 *     几何仍参与变换，却不可见；
	 *   · 目标子树：正常可见。
	 * 退出隔离时恢复原材质。
	 */
	isolate(node) {
		if (!this.viewer.content || !node) return;
		const root = this.viewer.content;

		this.restoreIsolation();

		const keep = new Set();
		node.traverse((n) => keep.add(n));

		// 祖先链：只保留变换通道，几何用幽灵材质隐藏
		const ancestors = [];
		let p = node.parent;
		while (p) {
			ancestors.push(p);
			if (p === root) break;
			p = p.parent;
		}

		root.traverse((n) => {
			if (n.userData && n.userData.__internal) return;
			n.visible = true;
		});
		root.visible = true;

		// 非目标子树 → 直接隐藏
		root.traverse((n) => {
			if (n.userData && n.userData.__internal) return;
			if (!keep.has(n) && !ancestors.includes(n)) n.visible = false;
		});

		// 祖先里带几何的 → 幽灵材质
		this._ghosts = [];
		ancestors.forEach((a) => {
			if (!a.isMesh || !a.material) return;
			const mats = Array.isArray(a.material) ? a.material : [a.material];
			this._ghosts.push({ node: a, original: a.material });
			const ghost = mats.map(() => {
				const g = new (mats[0].constructor)();
				g.transparent = true;
				g.opacity = 0;
				g.depthWrite = false;
				g.colorWrite = false;
				return g;
			});
			a.material = Array.isArray(a.material) ? ghost : ghost[0];
		});

		this.partTree.syncVisibility();
		this.frameNode(node);
	}

	/** 退出隔离：恢复被替换的幽灵材质 */
	restoreIsolation() {
		if (this._ghosts && this._ghosts.length) {
			this._ghosts.forEach(({ node, original }) => {
				if (Array.isArray(node.material)) {
					node.material.forEach((m) => m.dispose && m.dispose());
				} else if (node.material && node.material.dispose) {
					node.material.dispose();
				}
				node.material = original;
			});
			this._ghosts = [];
		}
	}

	showAll() {
		if (!this.viewer.content) return;
		this.restoreIsolation();
		this.viewer.content.traverse((n) => {
			if (n.userData && n.userData.__internal) return;
			n.visible = true;
		});
		this.partTree.syncVisibility();
	}

	frameNode(node) {
		const box = new Box3().setFromObject(node);
		if (box.isEmpty()) return;
		const sphere = box.getBoundingSphere(new Sphere());
		const cam = this.viewer.defaultCamera;
		const ctrl = this.viewer.controls;

		const dir = new Vector3().subVectors(cam.position, ctrl.target).normalize();
		const fov = (cam.fov * Math.PI) / 180;
		const dist = (sphere.radius * 1.6) / Math.tan(fov / 2);

		ctrl.target.copy(sphere.center);
		cam.position.copy(sphere.center).addScaledVector(dir, dist);
		ctrl.update();
		this.annotations.layout();
		this.measure.layout();
	}

	exportPNG(transparent) {
		const data = capturePNG(this.viewer.renderer, this.viewer.scene, this.viewer.activeCamera, {
			width: 2000,
			transparent,
		});
		const base = (this.modelName || 'scene').replace(/\.[^.]+$/, '');
		const a = document.createElement('a');
		a.href = data;
		a.download = `${base}${transparent ? '-alpha' : ''}.png`;
		a.click();
	}
}
