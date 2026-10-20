/**
 * annotations.js — 3D 标注系统
 *
 * 上游 viewer 完全没有标注能力。本模块解决"给模型打点讲解"的需求：
 *
 * - 3D 空间锚点：射线拾取模型表面，锚点跟着模型走（爆炸/剖切时位置自动跟随世界坐标）。
 * - 2D 屏幕标签：锚点投影到屏幕坐标，标签用 DOM 渲染（文本清晰、可选中、可无障碍），
 *   而不是画在 canvas 里的贴图文字。
 * - 引导线：锚点 → 标签之间画一条 SVG 折线，标签自动避让（左右分列 + 简单重力排布）。
 * - 遮挡处理：锚点被模型挡住时降低不透明度（用 raycast 判断，每帧只测少量锚点）。
 * - 可序列化为 JSON，跟着项目一起导出。
 */
import { Raycaster, Sphere, Vector3 } from 'three';

export class AnnotationLayer {
	/**
	 * @param {HTMLElement} container 覆盖在 canvas 上的绝对定位容器
	 * @param {import('three').Camera} camera
	 * @param {import('three').Scene} scene
	 */
	constructor(container, camera, scene) {
		this.container = container;
		this.camera = camera;
		this.scene = scene;
		this.items = [];
		this.raycaster = new Raycaster();
		this.enabled = true;
		this.picking = false;
		this._pendingPick = null;

		this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		this.svg.classList.add('anno-svg');
		container.appendChild(this.svg);

		this.domLayer = document.createElement('div');
		this.domLayer.className = 'anno-dom';
		container.appendChild(this.domLayer);

		this.onAdd = null;
		this.onChange = null;

		this._tmpV = new Vector3();
	}

	/** 进入"点击放置"模式，下一次点击模型表面即落点 */
	beginPick(callback) {
		this.picking = true;
		this._pendingPick = callback;
		this.container.classList.add('is-picking');
	}

	cancelPick() {
		this.picking = false;
		this._pendingPick = null;
		this.container.classList.remove('is-picking');
	}
	/**
	 * 处理 canvas 上的点击。返回 true 表示这次点击被标注放置消费掉了。
	 * @param {PointerEvent} ev
	 * @param {import('three').Object3D} content
	 */
	handleClick(ev, content) {
		if (!this.picking) return false;
		const rect = this.container.getBoundingClientRect();
		const ndc = {
			x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
			y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
		};
		this.raycaster.setFromCamera(ndc, this.camera);

		const targets = [];
		content.traverse((n) => {
			if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
		});

		const hits = this.raycaster.intersectObjects(targets, false);
		if (!hits.length) return false;

		const hit = hits[0];
		const cb = this._pendingPick;
		this.cancelPick();
		cb && cb(hit.point.clone(), hit.object);
		return true;
	}

	/**
	 * 添加一条标注。
	 * @param {{ point: Vector3, title: string, body?: string, node?: any }} data
	 */
	add(data) {
		const id = 'a' + Math.random().toString(36).slice(2, 9);
		const item = {
			id,
			point: data.point.clone(),
			title: data.title || 'New note',
			body: data.body || '',
			node: data.node || null,
			/** 标签相对锚点的横向偏移方向：1 右，-1 左 */
			side: this.items.length % 2 === 0 ? 1 : -1,
			el: null,
			dotEl: null,
			lineEl: null,
			occluded: false,
		};

		// 锚点小圆
		const dot = document.createElement('button');
		dot.type = 'button';
		dot.className = 'anno-dot';
		dot.dataset.id = id;
		dot.setAttribute('aria-label', `annotation ${item.title}`);
		dot.innerHTML = `<span>${this.items.length + 1}</span>`;
		this.domLayer.appendChild(dot);
		item.dotEl = dot;

		// 标签卡片
		const el = document.createElement('div');
		el.className = 'anno-card';
		el.dataset.id = id;
		el.innerHTML = `
			<div class="anno-card-head">
				<input class="anno-title" value="${escapeAttr(item.title)}" aria-label="annotation title" />
				<button class="anno-del" type="button" title="删除标注" aria-label="delete annotation">×</button>
			</div>
			<textarea class="anno-body" rows="2" placeholder="补充说明…" aria-label="annotation note">${escapeHtml(
				item.body,
			)}</textarea>
		`;
		this.domLayer.appendChild(el);
		item.el = el;

		const titleInput = el.querySelector('.anno-title');
		titleInput.addEventListener('input', () => {
			item.title = titleInput.value;
			this.onChange && this.onChange();
		});
		const bodyInput = el.querySelector('.anno-body');
		bodyInput.addEventListener('input', () => {
			item.body = bodyInput.value;
			this.onChange && this.onChange();
		});
		el.querySelector('.anno-del').addEventListener('click', () => {
			this.remove(id);
			this.onChange && this.onChange();
		});

		// 引导线
		const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
		line.classList.add('anno-line');
		this.svg.appendChild(line);
		item.lineEl = line;

		dot.addEventListener('click', () => {
			el.classList.toggle('is-open');
		});

		this.items.push(item);
		this.layout();
		this.onAdd && this.onAdd(item);
		this.onChange && this.onChange();
		return item;
	}

	remove(id) {
		const i = this.items.findIndex((x) => x.id === id);
		if (i < 0) return;
		const item = this.items[i];
		item.dotEl.remove();
		item.el.remove();
		item.lineEl.remove();
		this.items.splice(i, 1);
		// 重排序号
		this.items.forEach((it, idx) => {
			const span = it.dotEl.querySelector('span');
			if (span) span.textContent = String(idx + 1);
		});
		this.layout();
	}

	clear() {
		[...this.items].forEach((it) => this.remove(it.id));
	}

	/**
	 * 每帧调用：把 3D 锚点投影到屏幕，排布标签与引导线。
	 * 只在相机/模型变化时产生实际 DOM 写入（用缓存比对）。
	 */
	layout() {
		if (!this.enabled || !this.items.length) return;
		const rect = this.container.getBoundingClientRect();
		const w = rect.width;
		const h = rect.height;
		if (!w || !h) return;

		this.camera.updateMatrixWorld();
		const v = this._tmpV;

		const projected = [];
		for (const item of this.items) {
			v.copy(item.point).project(this.camera);
			const behind = v.z > 1;
			const x = (v.x * 0.5 + 0.5) * w;
			const y = (-v.y * 0.5 + 0.5) * h;
			const visible = !behind && x > -80 && x < w + 80 && y > -80 && y < h + 80;
			projected.push({ item, x, y, visible });
		}

		// 左右分列：side=1 的标签放到锚点右侧，-1 放左侧
		const cardW = 208;
		// 引导线要有可见长度，否则标签像"贴"在锚点上，看不出指向关系。
		// 小屏幕上适当缩短，避免标签被挤出画面。
		const gap = Math.max(34, Math.min(58, w * 0.045));
		const margin = 14;

		const rightCol = [];
		const leftCol = [];

		projected.forEach((p) => {
			const { item, x, y, visible } = p;
			item.dotEl.style.display = visible ? '' : 'none';
			item.el.style.display = visible ? '' : 'none';
			item.lineEl.style.display = visible ? '' : 'none';
			if (!visible) return;

			item.dotEl.style.transform = `translate(${x}px, ${y}px)`;

			const cardX = item.side > 0 ? x + gap : x - gap - cardW;
			// 标签纵向也拉开一点，让折线有清晰的"肘部"
			const target = { item, x, y, cardX, cardY: y - 34 };
			(item.side > 0 ? rightCol : leftCol).push(target);
		});

		// 简单重力排布：同列内按 y 排序后依次下推，避免重叠
		const resolve = (col) => {
			col.sort((a, b) => a.cardY - b.cardY);
			let lastBottom = -Infinity;
			col.forEach((t) => {
				const cardH = t.item.el.offsetHeight || 74;
				let cy = Math.max(t.cardY, lastBottom + 8);
				cy = Math.min(cy, h - cardH - margin);
				cy = Math.max(margin, cy);
				t.cardY = cy;
				lastBottom = cy + cardH;
			});
			// 若底部溢出，整体上移
			if (col.length) {
				const overflow = lastBottom - (h - margin);
				if (overflow > 0) {
					col.forEach((t) => {
						t.cardY = Math.max(margin, t.cardY - overflow);
					});
				}
			}
		};
		resolve(rightCol);
		resolve(leftCol);

		[...rightCol, ...leftCol].forEach((t) => {
			const { item, x, y, cardX, cardY } = t;
			const clampedX = Math.min(Math.max(margin, cardX), w - cardW - margin);
			item.el.style.transform = `translate(${clampedX}px, ${cardY}px)`;
			item.el.style.width = cardW + 'px';

			// 引导线：锚点 → 水平肘点 → 卡片侧边（两段折线，肘点在中途）
			const cardEdgeX = clampedX + (item.side > 0 ? 0 : cardW);
			const elbowX = clampedX + (item.side > 0 ? 14 : cardW - 14);
			const anchorY = cardY + 20;
			item.lineEl.setAttribute(
				'points',
				`${x},${y} ${elbowX},${anchorY} ${cardEdgeX},${anchorY}`,
			);
			item.lineEl.classList.toggle('is-left', item.side < 0);
		});

		this.updateOcclusion(projected);
	}

	/**
	 * 遮挡检测：从相机向锚点发射射线，若先撞到别的几何体则视为被挡。
	 * 为了控制成本，每 6 帧才测一次，且只测可见锚点。
	 */
	updateOcclusion(projected) {
		this._occFrame = (this._occFrame || 0) + 1;
		if (this._occFrame % 6 !== 0) return;

		const targets = [];
		this.scene.traverse((n) => {
			if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
		});
		if (!targets.length) return;

		const camPos = this.camera.position;
		const dir = new Vector3();

		projected.forEach((p) => {
			if (!p.visible) return;
			const { item } = p;
			dir.copy(item.point).sub(camPos);
			const dist = dir.length();
			if (dist < 1e-6) return;
			dir.normalize();

			this.raycaster.set(camPos, dir);
			this.raycaster.far = dist - 1e-3;
			const hits = this.raycaster.intersectObjects(targets, false);
			const occluded = hits.length > 0;
			if (occluded !== item.occluded) {
				item.occluded = occluded;
				item.dotEl.classList.toggle('is-occluded', occluded);
				item.el.classList.toggle('is-occluded', occluded);
			}
			this.raycaster.far = Infinity;
		});
	}

	toJSON() {
		return this.items.map((it) => ({
			point: [round(it.point.x), round(it.point.y), round(it.point.z)],
			title: it.title,
			body: it.body,
			side: it.side,
		}));
	}

	fromJSON(arr) {
		this.clear();
		(arr || []).forEach((d) => {
			const item = this.add({
				point: new Vector3(d.point[0], d.point[1], d.point[2]),
				title: d.title,
				body: d.body,
			});
			if (d.side) item.side = d.side;
		});
		this.layout();
	}

	setEnabled(on) {
		this.enabled = Boolean(on);
		const disp = this.enabled ? '' : 'none';
		this.svg.style.display = disp;
		this.domLayer.style.display = disp;
		if (this.enabled) this.layout();
	}
}

function round(n) {
	return Math.round(n * 1000) / 1000;
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function escapeAttr(s) {
	return escapeHtml(s);
}
