/**
 * measure.js — 两点测距 + 包围盒尺寸
 *
 * 上游 viewer 没有任何测量能力。本模块提供：
 * - 点击两个表面点，量出真实世界距离（模型单位），并画出带刻度的 3D 线段。
 * - 吸附：射线命中点吸附到最近的顶点（阈值内），比"随便点表面"更准。
 * - 数值用 DOM 标签跟随中点投影显示，始终面向相机。
 *
 * 与标注层共用同一套屏幕投影思路，但更轻量（只有中点标签）。
 */
import {
	BufferGeometry,
	Group,
	Line,
	LineBasicMaterial,
	Mesh,
	MeshBasicMaterial,
	Raycaster,
	SphereGeometry,
	Vector3,
} from 'three';

export class MeasureController {
	/**
	 * @param {HTMLElement} container
	 * @param {import('three').Camera} camera
	 * @param {import('three').Scene} scene
	 */
	constructor(container, camera, scene) {
		this.container = container;
		this.camera = camera;
		this.scene = scene;

		this.active = false;
		this.raycaster = new Raycaster();
		this.group = new Group();
		this.group.name = '__measure__';
		this.scene.add(this.group);

		this.points = [];
		this.measurements = [];
		this.onUpdate = null;
		this._tmp = new Vector3();

		this.labelsEl = document.createElement('div');
		this.labelsEl.className = 'measure-labels';
		container.appendChild(this.labelsEl);
	}

	/** 进入测量模式 */
	begin() {
		this.active = true;
		this.points = [];
		this.container.classList.add('is-measuring');
	}

	cancel() {
		this.active = false;
		this.points = [];
		this.container.classList.remove('is-measuring');
	}

	clear() {
		this.measurements.forEach((m) => {
			this.group.remove(m.line);
			this.group.remove(m.sphereA);
			this.group.remove(m.sphereB);
			m.line.geometry.dispose();
			m.line.material.dispose();
			m.sphereA.geometry.dispose();
			m.sphereB.geometry.dispose();
			m.label.remove();
		});
		this.measurements = [];
		this.points = [];
	}

	/**
	 * @param {PointerEvent} ev
	 * @param {import('three').Object3D} content
	 * @returns {boolean} 是否消费了本次点击
	 */
	handleClick(ev, content) {
		if (!this.active) return false;

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
		const snapped = snapToVertex(hit, this.raycaster, 0.02 * (hit.distance || 1));
		this.points.push(snapped);

		if (this.points.length === 2) {
			this.commit(this.points[0], this.points[1]);
			this.points = [];
		}
		return true;
	}

	commit(a, b) {
		const dist = a.distanceTo(b);

		const geo = new BufferGeometry().setFromPoints([a, b]);
		const line = new Line(geo, new LineBasicMaterial({ color: 0xffd166, depthTest: false }));
		line.renderOrder = 950;
		line.userData.__internal = true;
		this.group.add(line);

		const sphGeo = new SphereGeometry(Math.max(dist * 0.008, 0.0015), 12, 12);
		const sphMat = new MeshBasicMaterial({ color: 0xffd166, depthTest: false });
		const sphereA = new Mesh(sphGeo, sphMat);
		sphereA.position.copy(a);
		sphereA.renderOrder = 951;
		sphereA.userData.__internal = true;
		const sphereB = new Mesh(sphGeo, sphMat);
		sphereB.position.copy(b);
		sphereB.renderOrder = 951;
		sphereB.userData.__internal = true;
		this.group.add(sphereA, sphereB);

		const label = document.createElement('div');
		label.className = 'measure-label';
		label.textContent = formatDistance(dist);
		this.labelsEl.appendChild(label);

		this.measurements.push({ a: a.clone(), b: b.clone(), dist, line, sphereA, sphereB, label, geo, sphGeo, sphMat });
		this.onUpdate && this.onUpdate(this.measurements);
		this.layout();
	}

	/** 每帧更新标签位置 */
	layout() {
		if (!this.measurements.length) return;
		const rect = this.container.getBoundingClientRect();
		if (!rect.width) return;
		this.camera.updateMatrixWorld();

		this.measurements.forEach((m) => {
			const mid = this._tmp.copy(m.a).add(m.b).multiplyScalar(0.5).project(this.camera);
			const x = (mid.x * 0.5 + 0.5) * rect.width;
			const y = (-mid.y * 0.5 + 0.5) * rect.height;
			const visible = mid.z <= 1;
			m.label.style.display = visible ? '' : 'none';
			m.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
		});
	}

	removeLast() {
		const m = this.measurements.pop();
		if (!m) return;
		this.group.remove(m.line, m.sphereA, m.sphereB);
		m.line.geometry.dispose();
		m.line.material.dispose();
		m.label.remove();
		this.onUpdate && this.onUpdate(this.measurements);
	}

	dispose() {
		this.clear();
		this.labelsEl.remove();
		this.scene.remove(this.group);
	}
}

/**
 * 把交点吸附到几何体最近顶点。只在阈值内吸附，避免远处误吸。
 */
function snapToVertex(hit, raycaster, threshold) {
	const obj = hit.object;
	const geo = obj.geometry;
	if (!geo || !geo.attributes || !geo.attributes.position) return hit.point.clone();

	const pos = geo.attributes.position;
	const local = obj.worldToLocal(hit.point.clone());
	let best = null;
	let bestD = threshold * threshold;
	const step = Math.max(1, Math.floor(pos.count / 4000)); // 大网格采样，避免卡顿

	for (let i = 0; i < pos.count; i += step) {
		const dx = pos.getX(i) - local.x;
		const dy = pos.getY(i) - local.y;
		const dz = pos.getZ(i) - local.z;
		const d = dx * dx + dy * dy + dz * dz;
		if (d < bestD) {
			bestD = d;
			best = new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i));
		}
	}
	if (!best) return hit.point.clone();
	return obj.localToWorld(best);
}

export function formatDistance(d) {
	if (d >= 1000) return (d / 1000).toFixed(2) + ' k';
	if (d >= 1) return d.toFixed(3);
	if (d >= 0.01) return d.toFixed(4);
	return d.toExponential(2);
}
