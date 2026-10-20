/**
 * section.js — 实时剖切（cross-section）系统
 *
 * 相对上游 three-gltf-viewer 的全新模块。实现要点：
 *
 * 1. 硬件裁剪：用 THREE.Plane + material.clippingPlanes，GPU 端裁掉平面一侧的片元，
 *    不做 CPU 逐面计算，因此对高面数模型几乎零成本。
 * 2. 实心封盖（cap）：裸裁剪会留下"空心"的洞。这里用模板缓冲增量计数法补截面：
 *      · 每个 mesh 加两个不可见 stencil mesh（BackSide 增量 / FrontSide 减量），
 *        两者叠加后，stencil != 0 的像素正好是"被切开的实体内部"。
 *      · 全场景只需要 **一个** 封盖平面 mesh（stencilFunc = NotEqual, ref = 0），
 *        在 stencil 非零处着色 —— 相比"每个 mesh 一个封盖面"省掉 N-1 个 draw call。
 * 3. 每帧只更新一个 Plane 的 normal/constant，不重建材质，剖切滑块可以 60fps 拖动。
 *
 * 依赖：renderer 必须开启 stencil（WebGLRenderer({ stencil: true })）。
 */
import {
	AlwaysStencilFunc,
	BackSide,
	Box3,
	Color,
	DecrementWrapStencilOp,
	DoubleSide,
	FrontSide,
	Group,
	IncrementWrapStencilOp,
	LineSegments,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	NotEqualStencilFunc,
	Plane,
	PlaneGeometry,
	EdgesGeometry,
	LineBasicMaterial,
	ReplaceStencilOp,
	Vector3,
} from 'three';

/** 世界坐标轴定义，UI 暴露为 X / Y / Z + 反向 */
export const AXES = {
	x: new Vector3(1, 0, 0),
	y: new Vector3(0, 1, 0),
	z: new Vector3(0, 0, 1),
};

const STENCIL_RENDER_ORDER = 10;
const CAP_RENDER_ORDER = 10.5;

export class SectionController {
	/**
	 * @param {import('three').WebGLRenderer} renderer
	 * @param {import('three').Scene} scene
	 */
	constructor(renderer, scene) {
		this.renderer = renderer;
		this.scene = scene;

		this.enabled = false;
		this.axis = 'x';
		this.flip = false;
		/** 归一化位置：0 = 包围盒最小端，1 = 最大端 */
		this.position = 0.5;
		this.showPlane = true;
		this.showCap = true;
		// 封盖色：默认用暖橙，和大多数模型的冷色/中性色形成对比，
		// 一眼能看出"这里是切开的实心截面"而不是空洞。
		this.capColor = new Color('#ff7a45');

		this.plane = new Plane(new Vector3(-1, 0, 0), 0);
		this.planes = [this.plane];

		this.content = null;
		this.bounds = null;
		/** @type {{mesh:any, stencilGroup:Group, materials:any[]}[]} */
		this.entries = [];

		this.capMesh = this.createCapMesh();
		this.helper = this.createHelper();

		this.renderer.localClippingEnabled = true;
	}

	/* ------------------------------------------------------------------ 封盖 */

	createCapMesh() {
		// 与 three.js 官方 webgl_clipping_stencil 示例一致的封盖配置：
		// · stencilFunc = NotEqual, ref = 0  → 只在"实体内部"像素上着色
		// · 三个 op 都设为 Replace，且 ref = 0 → 着色后把该像素的 stencil 归零，
		//   于是同一帧内多个重叠截面不会互相叠加出脏边。
		const mat = new MeshStandardMaterial({
			color: this.capColor,
			metalness: 0.05,
			roughness: 0.7,
			side: DoubleSide,
			// 关键：封盖平面**不能**被它自己那一个裁剪面裁掉，
			// 否则平面正好落在裁剪面上，会被 z-fighting / 精确裁剪吞掉，
			// 只剩零散像素（第一版截图里的橙色碎屑）。
			// 这里不给它挂 clippingPlanes；若将来支持多平面裁剪，
			// 应挂 "除自身之外" 的其他平面。
			clippingPlanes: null,
			stencilWrite: true,
			stencilRef: 0,
			stencilFunc: NotEqualStencilFunc,
			stencilFail: ReplaceStencilOp,
			stencilZFail: ReplaceStencilOp,
			stencilZPass: ReplaceStencilOp,
		});
		const mesh = new Mesh(new PlaneGeometry(1, 1), mat);
		mesh.name = '__section_cap__';
		mesh.renderOrder = CAP_RENDER_ORDER;
		mesh.visible = false;
		mesh.frustumCulled = false;
		// 封盖画完立刻清 stencil，避免跨帧累积成噪点
		mesh.onAfterRender = (renderer) => renderer.clearStencil();
		mesh.userData.__internal = true;
		this.scene.add(mesh);
		return mesh;
	}

	/**
	 * 为单个几何体创建一对"只写 stencil 不写颜色"的代理 mesh。
	 *
	 * 原理（同 three.js 官方 webgl_clipping_stencil）：
	 *   BackSide  每像素 +1，FrontSide 每像素 -1。
	 *   对于封闭实体，视线穿过"背面"的次数比"正面"多 1，
	 *   净结果 = 1 的像素就是被裁掉的实体内部 → 封盖画在这里。
	 *
	 * 必须保留 depthTest：否则同一像素上前后两个零件会无差别累加，
	 * stencil 溢出成噪点（第一版截图里的橙色碎屑就是这个原因）。
	 */
	createStencilGroup(geometry) {
		const group = new Group();
		group.name = '__section_stencil__';
		group.userData.__internal = true;

		const base = new MeshBasicMaterial();
		base.depthWrite = false;
		base.depthTest = true;
		base.colorWrite = false;
		base.stencilWrite = true;
		base.stencilFunc = AlwaysStencilFunc;
		base.clippingPlanes = this.planes;

		const back = base.clone();
		back.side = BackSide;
		back.stencilFail = IncrementWrapStencilOp;
		back.stencilZFail = IncrementWrapStencilOp;
		back.stencilZPass = IncrementWrapStencilOp;

		const front = base.clone();
		front.side = FrontSide;
		front.stencilFail = DecrementWrapStencilOp;
		front.stencilZFail = DecrementWrapStencilOp;
		front.stencilZPass = DecrementWrapStencilOp;

		const mBack = new Mesh(geometry, back);
		mBack.renderOrder = STENCIL_RENDER_ORDER;
		mBack.frustumCulled = false;
		mBack.userData.__internal = true;
		group.add(mBack);

		const mFront = new Mesh(geometry, front);
		mFront.renderOrder = STENCIL_RENDER_ORDER;
		mFront.frustumCulled = false;
		mFront.userData.__internal = true;
		group.add(mFront);

		base.dispose();
		return group;
	}

	/* ------------------------------------------------------------------ 绑定 */

	/**
	 * @param {import('three').Object3D|null} content
	 */
	setContent(content) {
		this.disposeContent();
		this.content = content;
		if (!content) return;

		const box = new Box3().setFromObject(content);
		this.bounds = {
			min: box.min.clone(),
			max: box.max.clone(),
			center: box.getCenter(new Vector3()),
			size: box.getSize(new Vector3()),
		};

		content.updateMatrixWorld(true);

		content.traverse((node) => {
			if (!node.isMesh || !node.geometry) return;
			if (node.userData.__internal) return;

			const sourceMats = Array.isArray(node.material) ? node.material : [node.material];
			const cloned = sourceMats.map((m) => {
				const c = m.clone();
				c.clippingPlanes = this.planes;
				c.clipShadows = true;
				// 剖开后能看到内壁，双面渲染
				if (c.side !== undefined) c.side = DoubleSide;
				c.needsUpdate = true;
				return c;
			});

			const entry = {
				mesh: node,
				original: sourceMats,
				cloned,
				stencilGroup: null,
			};

			// 蒙皮网格的封盖在顶点动画下会错位，只做裁剪不做封盖
			if (!node.isSkinnedMesh) {
				// 关键：stencil 组必须挂在 scene 下、且独立于模型层级。
				// 若挂成 mesh 的子节点，会继承父级的 renderOrder 排序，
				// 与模型的透明/不透明分桶混在一起，stencil 累加顺序就乱了。
				const sg = this.createStencilGroup(node.geometry);
				sg.matrixAutoUpdate = false;
				this.scene.add(sg);
				entry.stencilGroup = sg;
				sg.visible = false;
			}

			node.material = Array.isArray(node.material) ? cloned : cloned[0];
			node.userData.__sectionEntry = entry;
			this.entries.push(entry);
		});

		this.applyState();
		this.update();
	}

	/* ------------------------------------------------------------------ 状态 */

	setEnabled(on) {
		this.enabled = Boolean(on);
		this.applyState();
		this.update();
	}

	/**
	 * 把 stencil 组的变换同步到对应 mesh 的世界矩阵。
	 * 因为它们是 scene 的子节点（而不是 mesh 的子节点），
	 * 需要每帧手动跟随 —— 否则爆炸视图位移后封盖会错位。
	 */
	syncStencilTransforms() {
		if (!this.enabled) return;
		for (const e of this.entries) {
			if (!e.stencilGroup) continue;
			e.mesh.updateWorldMatrix(true, false);
			const g = e.stencilGroup;
			// 组本身用单位矩阵，把 mesh 的世界矩阵直接下发给两个子 mesh。
			// （组设了 matrixAutoUpdate=false，但子 mesh 仍会各自 updateMatrixWorld，
			//   所以这里不能只改组矩阵，必须逐个子节点写。）
			g.position.set(0, 0, 0);
			g.quaternion.identity();
			g.scale.set(1, 1, 1);
			g.updateMatrix();
			g.updateMatrixWorld(true);
			for (const child of g.children) {
				child.matrixAutoUpdate = false;
				child.matrix.copy(e.mesh.matrixWorld);
				child.matrixWorld.copy(e.mesh.matrixWorld);
				child.matrixWorldNeedsUpdate = false;
			}
		}
	}

	applyState() {
		this.entries.forEach((e) => {
			e.cloned.forEach((m) => {
				m.clippingPlanes = this.enabled ? this.planes : null;
				m.needsUpdate = true;
			});
			if (e.stencilGroup) e.stencilGroup.visible = this.enabled && this.showCap;
		});
		this.capMesh.visible = this.enabled && this.showCap && this.entries.length > 0;
		this.helper.visible = this.enabled && this.showPlane;
	}

	setAxis(axis) {
		if (!AXES[axis]) return;
		this.axis = axis;
		this.update();
	}

	setFlip(flip) {
		this.flip = Boolean(flip);
		this.update();
	}

	setPosition(t) {
		this.position = Math.min(1, Math.max(0, t));
		this.update();
	}

	setCapVisible(on) {
		this.showCap = Boolean(on);
		this.applyState();
	}

	setPlaneVisible(on) {
		this.showPlane = Boolean(on);
		this.applyState();
	}

	setCapColor(hex) {
		this.capColor.set(hex);
		this.capMesh.material.color.set(hex);
		this.capMesh.material.needsUpdate = true;
	}

	/* ------------------------------------------------------------------ 平面 */

	update() {
		if (!this.bounds) return;

		const { min, max, center, size } = this.bounds;
		const axis = this.axis;

		// 法线方向决定裁掉哪一侧；flip 取反
		const normal = AXES[axis].clone().multiplyScalar(this.flip ? 1 : -1).normalize();

		const lo = min[axis];
		const hi = max[axis];
		const coord = lo + (hi - lo) * this.position;

		const pointOnPlane = center.clone();
		pointOnPlane[axis] = coord;

		this.plane.normal.copy(normal);
		this.plane.constant = -normal.dot(pointOnPlane);

		// 截面尺寸：严格贴合该截面上的实际长宽（不做大幅放大）。
		// 早期版本用"最大跨度 × 1.18"，对细长模型会变成一块比模型大很多的板，
		// 直接糊住整个画面。
		const spans = [];
		if (axis !== 'x') spans.push(size.x);
		if (axis !== 'y') spans.push(size.y);
		if (axis !== 'z') spans.push(size.z);
		const spanX = Math.max(spans[0] || 1, 1e-4) * 1.02;
		const spanY = Math.max(spans[1] || 1, 1e-4) * 1.02;

		// 封盖平面：贴合裁剪面，尺寸按该截面上的实际长宽
		this.capMesh.position.copy(pointOnPlane);
		this.capMesh.scale.set(spanX, spanY, 1);
		const zAxis = new Vector3(0, 0, 1);
		this.capMesh.quaternion.setFromUnitVectors(zAxis, normal.clone().negate());

		// 辅助指示面：比封盖稍大一点点，但不夸张
		const h = this.helper;
		h.position.copy(pointOnPlane);
		h.scale.set(spanX * 1.02, spanY * 1.02, 1);
		h.quaternion.copy(this.capMesh.quaternion);

		// 让封盖跟随"内壁可见"的观感：法线朝向观察者一侧时也能着色
		this.capMesh.material.side = DoubleSide;
	}

	/* ------------------------------------------------------------------ 指示器 */

	createHelper() {
		const group = new Group();
		group.name = '__section_helper__';
		group.visible = false;
		group.userData.__internal = true;

		const geo = new PlaneGeometry(1, 1);
		const fill = new Mesh(
			geo,
			new MeshBasicMaterial({
				color: 0x4da3ff,
				transparent: true,
				opacity: 0.035,
				side: DoubleSide,
				depthWrite: false,
				depthTest: false,
			}),
		);
		fill.renderOrder = 901;
		group.add(fill);

		// 只画外框，不画填充网格 —— 让指示器"框住截面"而不是"糊住画面"
		const edges = new LineSegments(
			new EdgesGeometry(geo),
			new LineBasicMaterial({
				color: 0x5aa9ff,
				transparent: true,
				opacity: 0.75,
				depthTest: false,
			}),
		);
		edges.renderOrder = 902;
		group.add(edges);

		this.scene.add(group);
		return group;
	}

	/* ------------------------------------------------------------------ 清理 */

	disposeContent() {
		this.entries.forEach((e) => {
			if (e.mesh) {
				e.mesh.material = Array.isArray(e.original) ? e.original : e.original[0];
				e.mesh.userData.__sectionEntry = null;
			}
			if (e.stencilGroup && e.stencilGroup.parent) {
				e.stencilGroup.parent.remove(e.stencilGroup);
				e.stencilGroup.traverse((n) => {
					if (n.material) n.material.dispose();
				});
			}
			e.cloned.forEach((m) => m.dispose());
		});
		this.entries.length = 0;
		this.content = null;
		this.bounds = null;
		if (this.capMesh) this.capMesh.visible = false;
		if (this.helper) this.helper.visible = false;
	}

	dispose() {
		this.disposeContent();
		if (this.capMesh) {
			this.scene.remove(this.capMesh);
			this.capMesh.geometry.dispose();
			this.capMesh.material.dispose();
		}
		if (this.helper) {
			this.scene.remove(this.helper);
			this.helper.traverse((n) => {
				if (n.geometry) n.geometry.dispose();
				if (n.material) n.material.dispose();
			});
		}
	}
}
