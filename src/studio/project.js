/**
 * project.js — 项目文件（.gltfstudio.json）读写 + 截图导出
 *
 * 上游只能"看"，看完就没了。这里把用户的工作状态沉淀成可复现的文件：
 * 相机位姿、剖切参数、爆炸参数、标注、测量、可见性、灯光环境，全部序列化。
 * 别人拿到 json + 原模型就能 1:1 复现同一视图，适合做评审交付。
 *
 * 截图走 renderer.domElement.toDataURL，但需要 preserveDrawingBuffer 或
 * 在 render 之后立刻读取 —— 这里用"渲染后同帧读取"的稳妥做法。
 */
import { Vector2 } from 'three';

export const PROJECT_VERSION = 1;

export function serializeProject(viewer, studio) {
	const cam = viewer.defaultCamera;

	return {
		schema: 'gltf-studio/project',
		version: PROJECT_VERSION,
		createdAt: new Date().toISOString(),
		generator: 'glTF Studio (built on donmccurdy/three-gltf-viewer)',
		model: studio.modelName || null,
		camera: {
			position: cam.position.toArray().map(round),
			target: viewer.controls.target.toArray().map(round),
			fov: cam.fov,
			up: cam.up.toArray(),
		},
		section: {
			enabled: studio.section.enabled,
			axis: studio.section.axis,
			flip: studio.section.flip,
			position: round(studio.section.position),
			showCap: studio.section.showCap,
			showPlane: studio.section.showPlane,
			capColor: '#' + studio.section.capColor.getHexString(),
		},
		explode: {
			amount: round(studio.explode.amount),
			mode: studio.explode.mode,
			axis: studio.explode.axis,
			topLevelOnly: studio.explode.topLevelOnly,
		},
		display: {
			background: viewer.state.background,
			bgColor: viewer.state.bgColor,
			wireframe: viewer.state.wireframe,
			grid: viewer.state.grid,
			environment: viewer.state.environment,
			exposure: viewer.state.exposure,
			toneMapping: viewer.state.toneMapping,
		},
		annotations: studio.annotations.toJSON(),
		measurements: studio.measure.toJSON ? studio.measure.toJSON() : [],
		hidden: studio.hiddenNodes || [],
	};
}

export function applyProject(viewer, studio, data) {
	if (!data || data.schema !== 'gltf-studio/project') {
		throw new Error('不是有效的 glTF Studio 项目文件');
	}

	const s = data.section || {};
	if (typeof s.enabled === 'boolean') studio.section.setEnabled(s.enabled);
	if (s.axis) studio.section.setAxis(s.axis);
	if (typeof s.flip === 'boolean') studio.section.setFlip(s.flip);
	if (typeof s.position === 'number') studio.section.setPosition(s.position);
	if (typeof s.showCap === 'boolean') studio.section.setCapVisible(s.showCap);
	if (typeof s.showPlane === 'boolean') studio.section.setPlaneVisible(s.showPlane);
	if (s.capColor) studio.section.setCapColor(s.capColor);

	const e = data.explode || {};
	if (e.mode) studio.explode.setMode(e.mode);
	if (e.axis) studio.explode.setAxis(e.axis);
	if (typeof e.topLevelOnly === 'boolean') studio.explode.setTopLevelOnly(e.topLevelOnly);
	if (typeof e.amount === 'number') studio.explode.setAmount(e.amount);

	const d = data.display || {};
	if (typeof d.background === 'boolean') viewer.state.background = d.background;
	if (d.bgColor) viewer.state.bgColor = d.bgColor;
	if (typeof d.wireframe === 'boolean') viewer.state.wireframe = d.wireframe;
	if (typeof d.grid === 'boolean') viewer.state.grid = d.grid;
	if (d.environment) viewer.state.environment = d.environment;
	if (typeof d.exposure === 'number') viewer.state.exposure = d.exposure;
	if (typeof d.toneMapping === 'number') viewer.state.toneMapping = d.toneMapping;
	viewer.updateBackground && viewer.updateBackground();
	viewer.updateEnvironment && viewer.updateEnvironment();
	viewer.updateDisplay && viewer.updateDisplay();
	viewer.updateLights && viewer.updateLights();
	viewer.refreshGUI && viewer.refreshGUI();

	const c = data.camera;
	if (c && c.position) {
		viewer.defaultCamera.position.fromArray(c.position);
		if (c.target) viewer.controls.target.fromArray(c.target);
		if (typeof c.fov === 'number') {
			viewer.defaultCamera.fov = c.fov;
			viewer.defaultCamera.updateProjectionMatrix();
		}
		viewer.controls.update();
	}

	if (data.annotations) studio.annotations.fromJSON(data.annotations);
	if (data.measurements && studio.measure.fromJSON) studio.measure.fromJSON(data.measurements);
	if (data.hidden && studio.applyHidden) studio.applyHidden(data.hidden);

	return data;
}

/**
 * 截当前画面为 PNG。为保证拿到最新帧，先同步渲染一次再读像素。
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').Scene} scene
 * @param {import('three').Camera} camera
 * @param {{ width?: number, height?: number, transparent?: boolean }} opts
 */
export function capturePNG(renderer, scene, camera, opts = {}) {
	const { width = 1600, transparent = false } = opts;
	const aspect = renderer.domElement.width / renderer.domElement.height;
	const height = opts.height || Math.round(width / aspect);

	const prevSize = renderer.getSize(new Vector2());
	const prevRatio = renderer.getPixelRatio();
	const prevBg = scene.background;
	const prevAlpha = renderer.getClearAlpha();

	const target = document.createElement('canvas');
	target.width = width;
	target.height = height;

	renderer.setPixelRatio(1);
	renderer.setSize(width, height, false);
	if (transparent) {
		scene.background = null;
		renderer.setClearAlpha(0);
	}

	renderer.render(scene, camera);

	const ctx = target.getContext('2d');
	ctx.drawImage(renderer.domElement, 0, 0, width, height);

	// 还原
	scene.background = prevBg;
	renderer.setClearAlpha(prevAlpha);
	renderer.setPixelRatio(prevRatio);
	renderer.setSize(prevSize.x, prevSize.y, false);

	return target.toDataURL('image/png');
}

export function download(filename, content, mime = 'application/json') {
	const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function round(n) {
	return Math.round(n * 10000) / 10000;
}
