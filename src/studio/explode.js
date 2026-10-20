/**
 * explode.js — 爆炸视图（exploded view）系统
 *
 * 相对上游 three-gltf-viewer 的全新模块。解决的真实痛点：
 * 装配体/整机模型在预览器里只能整体看，看不出层级结构和零件关系。
 *
 * 实现思路：
 * - 不修改模型的局部变换（那会破坏动画/骨骼），而是在**每个节点的父空间**里记录
 *   一个额外偏移量，渲染前叠加到 position 上，关闭时还原。
 * - 位移方向有两种：
 *     'radial'  —— 从装配体中心沿径向炸开（适合机械零件、人形部件）
 *     'axis'    —— 沿指定世界轴（X/Y/Z）单方向分层展开（适合层状结构、建筑剖面）
 * - 每个节点按"距中心的深度"获得不同系数，形成由内向外的层次感。
 * - 全程用缓动函数驱动 t∈[0,1]，可中断、可反向，不依赖第三方动画库。
 *
 * 关键设计：只在 `t` 变化时重算偏移（dirty flag），静止时不产生任何计算。
 */
import { Box3, Quaternion, Vector3 } from 'three';

/** 缓动：先快后慢，适合"炸开"这种有惯性感的动作 */
function easeOutCubic(t) {
	return 1 - Math.pow(1 - t, 3);
}

/** 缓动：带轻微回弹，展开收尾更有弹性 */
function easeOutBack(t) {
	const c1 = 1.70158;
	const c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export class ExplodeController {
	/**
	 * @param {import('three').Object3D|null} content
	 */
	constructor(content = null) {
		this.content = null;
		/** 0..1 展开程度 */
		this.amount = 0;
		/** 最大位移距离（世界单位），由包围盒尺寸推导 */
		this.distance = 1;
		this.mode = 'radial'; // 'radial' | 'axis'
		this.axis = 'y';
		/** 只炸开顶层节点（true）还是递归所有节点（false） */
		this.topLevelOnly = false;

		this.duration = 620; // ms
		this._raf = 0;
		this._from = 0;
		this._to = 0;
		this._start = 0;
		this._dirty = true;
		this._onChange = null;

		/** @type {{node:any, base:Vector3, dir:Vector3, weight:number}[]} */
		this.nodes = [];
		this.center = new Vector3();
		this.size = new Vector3();

		if (content) this.setContent(content);
	}

	setContent(content) {
		this.restore();
		this.content = content;
		this.nodes.length = 0;
		if (!content) return;

		content.updateMatrixWorld(true);
		const box = new Box3().setFromObject(content);
		this.center.copy(box.getCenter(new Vector3()));
		box.getSize(this.size);

		// 最大位移距离：按包围球半径的 55% 计算。
		// 之前用"对角线 × 0.42"，对细长模型（机械臂）会过大，
		// 零件直接被推出画面。这里改成相对包围球半径，尺度稳定。
		const radius = this.size.length() / 2 || 1;
		this.distance = radius * 0.55;

		// 爆炸后的最大外扩半径（用于让相机自动放宽视野）
		this.expandedRadius = radius * 1.55;

		const maxDist = Math.max(this.size.x, this.size.y, this.size.z) / 2 || 1;

		/**
		 * 收集所有"有几何的节点"，并继续向下遍历。
		 *
		 * 上游常见的坑：很多装配体是「父节点自带 mesh，子节点还有 mesh」
		 * （例如 base 上装着 turret）。如果遇到 mesh 就 return，
		 * 整个子层级都会被跳过，爆炸视图只剩 1 个零件。
		 *
		 * 这里改为：mesh 也要继续下钻；父子位移的叠加问题由 apply() 里的
		 * "增量偏移"解决（子节点只补足与父节点的差额，不重复叠加）。
		 */
		const collect = (node, depth) => {
			if (node === content) {
				node.children.forEach((child) => collect(child, depth + 1));
				return;
			}
			if (node.userData && node.userData.__internal) return;

			if (node.isMesh) {
				const worldPos = node.getWorldPosition(new Vector3());
				const dir = worldPos.clone().sub(this.center);
				const dist = dir.length();
				if (dist < 1e-6) {
					// 正好在中心：给一个稳定的伪随机方向，避免所有零件重叠
					const seed = this.nodes.length * 2.399963;
					dir.set(Math.cos(seed), Math.sin(seed * 1.7) * 0.5, Math.sin(seed)).normalize();
				} else {
					dir.normalize();
				}
				// 越靠外的零件位移越大，形成层次
				const weight = 0.35 + 0.65 * Math.min(1, dist / maxDist);
				this.nodes.push({
					node,
					base: node.position.clone(),
					dir,
					weight,
					depth,
					/** 父级累积的世界位移，apply 时用于求差额 */
					parentAccum: new Vector3(),
				});
			}

			if (this.topLevelOnly && depth >= 1) return;
			node.children.forEach((child) => collect(child, depth + 1));
		};

		collect(content, 0);
		this._dirty = true;
		this.apply();
	}

	setTopLevelOnly(v) {
		const content = this.content;
		this.topLevelOnly = Boolean(v);
		if (content) this.setContent(content);
	}

	setMode(mode) {
		this.mode = mode === 'axis' ? 'axis' : 'radial';
		this._dirty = true;
		this.apply();
	}

	setAxis(axis) {
		this.axis = ['x', 'y', 'z'].includes(axis) ? axis : 'y';
		this._dirty = true;
		this.apply();
	}

	setAmount(v, { animate = false } = {}) {
		const target = Math.min(1, Math.max(0, v));
		if (animate) {
			this.animateTo(target);
		} else {
			this.amount = target;
			this._dirty = true;
			this.apply();
			this._onChange && this._onChange(this.amount);
		}
	}

	onChange(fn) {
		this._onChange = fn;
	}

	animateTo(target, duration = this.duration) {
		cancelAnimationFrame(this._raf);
		this._from = this.amount;
		this._to = target;
		this._start = performance.now();
		const tick = (now) => {
			const p = Math.min(1, (now - this._start) / duration);
			const e = easeOutBack(p);
			this.amount = this._from + (this._to - this._from) * e;
			this._dirty = true;
			this.apply();
			this._onChange && this._onChange(this.amount);
			if (p < 1) {
				this._raf = requestAnimationFrame(tick);
			} else {
				this.amount = this._to;
				this.apply();
			}
		};
		this._raf = requestAnimationFrame(tick);
	}

	toggle() {
		this.animateTo(this.amount > 0.5 ? 0 : 1);
	}

	/**
	 * 计算并写入位移。
	 *
	 * 关键：three.js 里子节点会继承父节点位移。若父子都各自加一份偏移，
	 * 子零件会被推两倍远，爆炸图会散架。
	 * 这里按"由外到内"（父 → 子）的顺序处理，每个节点只补足
	 * 「自己应有的世界位移 − 父节点已经带走的位移」这个差额。
	 */
	apply() {
		if (!this._dirty || !this.nodes.length) return;
		this._dirty = false;

		const t = easeOutCubic(Math.min(1, Math.max(0, this.amount)));
		const d = this.distance * t;

		const axisVec =
			this.axis === 'x'
				? new Vector3(1, 0, 0)
				: this.axis === 'z'
					? new Vector3(0, 0, 1)
					: new Vector3(0, 1, 0);

		// 按 depth 升序，保证父节点先算出累积位移
		const ordered = [...this.nodes].sort((a, b) => a.depth - b.depth);
		const accumByNode = new Map();

		for (const item of ordered) {
			// 找到最近的、也在爆炸列表里的祖先，取其累积位移
			let p = item.node.parent;
			let parentAccum = null;
			while (p) {
				if (accumByNode.has(p)) {
					parentAccum = accumByNode.get(p);
					break;
				}
				p = p.parent;
			}
			if (!parentAccum) parentAccum = new Vector3();

			// 这个零件"应该"获得的局部位移
			let desired;
			if (this.mode === 'axis') {
				const worldPos = item.node.getWorldPosition(new Vector3());
				const rel = worldPos.clone().sub(this.center).dot(axisVec);
				const sign = rel >= 0 ? 1 : -1;
				desired = axisVec.clone().multiplyScalar(sign * d * item.weight);
			} else {
				desired = item.dir.clone().multiplyScalar(d * item.weight);
			}

			// 差额 = 期望位移 − 父节点已带走的位移
			const delta = desired.clone().sub(parentAccum);

			// 父节点的旋转会改变子节点局部位移的方向，这里把差额转回父空间
			const parent = item.node.parent;
			if (parent) {
				const q = parent.getWorldQuaternion(new Quaternion());
				q.invert();
				delta.applyQuaternion(q);
			}

			item.node.position.copy(item.base).add(delta);
			accumByNode.set(item.node, desired);
		}
	}

	/** 还原所有位移 */
	restore() {
		cancelAnimationFrame(this._raf);
		this.amount = 0;
		this.nodes.forEach((item) => {
			if (item.node) item.node.position.copy(item.base);
		});
		this._dirty = true;
	}

	dispose() {
		cancelAnimationFrame(this._raf);
		this.restore();
		this.nodes.length = 0;
		this.content = null;
	}
}
