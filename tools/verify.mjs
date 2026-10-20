/**
 * tools/verify.mjs — 端到端验收脚本
 *
 * 用真实 Chromium 跑一遍核心交互，抓取截图并输出可复现的断言结果。
 * 不是"看一眼截图说通过"，每一步都读真实 DOM / WebGL 状态。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5183/';
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok: Boolean(ok), detail });
	const mark = ok ? 'PASS' : 'FAIL';
	console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({
	// 用真实 GPU（D3D11）而非 SwiftShader 软件渲染。
	// 原因：SwiftShader 下基线本身就只有 ~30fps，测出来的数字反映的是
	// 软件光栅化器的上限，不是本项目的开销（见 README 性能章节的对照数据）。
	args: [
		'--use-angle=d3d11',
		'--enable-gpu',
		'--ignore-gpu-blocklist',
		'--enable-unsafe-swiftshader',
	],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
	if (m.type() === 'error') errors.push('console: ' + m.text());
});

console.log('→ 打开', BASE);
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1. 面板存在
const panel = await page.$('.studio-panel');
check('工作台面板渲染', Boolean(panel));

// 2. 载入模型
console.log('→ 载入 RoboticArm.glb');
await page.goto(BASE + '?model=/assets/models/RoboticArm.glb', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.VIEWER && window.VIEWER.scene, { timeout: 90000 });
await page.waitForTimeout(2500);

const info = await page.evaluate(() => {
	const s = window.VIEWER.scene;
	let meshes = 0;
	let tris = 0;
	s.traverse((n) => {
		if (n.isMesh && n.geometry) {
			meshes++;
			const g = n.geometry;
			const c = g.index ? g.index.count : g.attributes.position.count;
			tris += Math.floor(c / 3);
		}
	});
	return { meshes, tris, children: s.children.length };
});
check('模型加载成功', info.meshes > 0, `${info.meshes} meshes / ${info.tris} tris`);

// 3. 零件树填充
const treeRows = await page.$$eval('.ptree-row', (els) => els.length);
check('零件树生成节点', treeRows > 3, `${treeRows} 行`);

// 4. 剖切：开启并截图（用 Y 轴水平剖，最能体现"看内部"的价值）
await page.click('.sp-switch .sp-track');
await page.waitForTimeout(400);
await page.click('[data-axis="y"]');
await page.waitForTimeout(200);
const secState = await page.evaluate(() => {
	const s = window.VIEWER.app.studio.section;
	return { enabled: s.enabled, axis: s.axis, entries: s.entries.length, capVisible: s.capMesh.visible };
});
check('剖切启用', secState.enabled && secState.entries > 0, `${secState.entries} 个 mesh 接管`);

// 拖动滑块到 62%
await page.$eval('#sec-pos', (el) => {
	el.value = '0.62';
	el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);

const clipCheck = await page.evaluate(() => {
	const s = window.VIEWER.app.studio.section;
	const mats = s.entries[0].cloned;
	return {
		planesAttached: mats.every((m) => Array.isArray(m.clippingPlanes) && m.clippingPlanes.length === 1),
		planeConstant: s.plane.constant,
		normal: s.plane.normal.toArray(),
		stencilGroups: s.entries.filter((e) => e.stencilGroup).length,
	};
});
check(
	'裁剪平面挂载到材质',
	clipCheck.planesAttached,
	`constant=${clipCheck.planeConstant.toFixed(3)} normal=[${clipCheck.normal.map((n) => n.toFixed(2))}]`,
);
check('模板缓冲代理生成', clipCheck.stencilGroups > 0, `${clipCheck.stencilGroups} 组`);

// 4b. 封盖是否真的"成片"填充截面 —— 用 readPixels 统计封盖色像素数，
//     避免"看起来有颜色"但其实只是零散噪点（开发中真实踩过这个坑）。
const capPixels = await page.evaluate(() => {
	const s = window.VIEWER.app.studio.section;
	const v = window.VIEWER.app.viewer;
	const prevPlane = s.showPlane;
	s.setPlaneVisible(false); // 关掉指示框，只统计封盖本身
	v.render();
	const gl = v.renderer.getContext();
	const W = gl.drawingBufferWidth;
	const H = gl.drawingBufferHeight;
	const px = new Uint8Array(W * H * 4);
	gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
	let cap = 0;
	for (let i = 0; i < px.length; i += 4) {
		const r = px[i];
		const g = px[i + 1];
		const b = px[i + 2];
		// 封盖色 #ff7a45 经光照后的色相判据
		if (r > 140 && g > 50 && g < 190 && b < 130 && r > g + 30 && g >= b) cap++;
	}
	s.setPlaneVisible(prevPlane);
	v.render();
	return { cap, total: W * H };
});
check(
	'剖切封盖实心填充',
	capPixels.cap > 3000,
	`封盖像素 ${capPixels.cap.toLocaleString()}（占画面 ${((capPixels.cap / capPixels.total) * 100).toFixed(2)}%）`,
);

await page.screenshot({ path: path.join(OUT, '01-section.png') });

// 5. 爆炸视图
await page.click('#exp-toggle');
await page.waitForTimeout(900);
const expAmt = await page.evaluate(() => window.VIEWER.app.studio.explode.amount);
check('爆炸视图动画到位', expAmt > 0.95, `amount=${expAmt.toFixed(3)}`);

// 位移是否真的发生
const moved = await page.evaluate(() => {
	const e = window.VIEWER.app.studio.explode;
	let movedCount = 0;
	e.nodes.forEach((n) => {
		if (n.node.position.distanceTo(n.base) > 1e-4) movedCount++;
	});
	return { movedCount, total: e.nodes.length };
});
check('节点位移生效', moved.movedCount > 0, `${moved.movedCount}/${moved.total} 节点偏移`);
await page.screenshot({ path: path.join(OUT, '02-explode.png') });

// 6. 标注：用射线扫描找到一个真实命中点，再放标注
const anno = await page.evaluate(() => {
	const studio = window.VIEWER.app.studio;
	const viewer = window.VIEWER.app.viewer;
	const THREE = window.THREE;
	const ray = new THREE.Raycaster();
	const targets = [];
	viewer.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
	});
	// 屏幕中心未必有几何（模型是细长机械臂），扫网格找第一个命中
	let hit = null;
	outer: for (let gx = -0.7; gx <= 0.7; gx += 0.1) {
		for (let gy = -0.7; gy <= 0.7; gy += 0.1) {
			ray.setFromCamera(new THREE.Vector2(gx, gy), viewer.defaultCamera);
			const h = ray.intersectObjects(targets, false);
			if (h.length) {
				hit = h[0];
				break outer;
			}
		}
	}
	if (!hit) return { ok: false, reason: 'no hit' };

	studio.annotations.add({ point: hit.point.clone(), title: hit.object.name || 'Part' });
	studio.annotations.layout();
	const dot = document.querySelector('.anno-dot');
	const card = document.querySelector('.anno-card');
	return {
		ok: true,
		dotVisible: dot && dot.style.display !== 'none',
		cardVisible: card && card.style.display !== 'none',
		dotTransform: dot && dot.style.transform,
		count: document.querySelectorAll('.anno-dot').length,
	};
});
check('标注锚点创建并投影', anno.ok && anno.dotVisible, `dot transform=${anno.dotTransform}`);

// 6b. 真实鼠标交互：点「＋ 点选模型添加」→ 在 canvas 上真点一下 → 应新增标注
await page.evaluate(() => window.VIEWER.app.studio.annotations.clear());
// 先算出一个"确实落在模型上"的屏幕坐标
const clickTarget = await page.evaluate(() => {
	const v = window.VIEWER.app.viewer;
	const THREE = window.THREE;
	const ray = new THREE.Raycaster();
	const targets = [];
	v.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
	});
	const rect = v.renderer.domElement.getBoundingClientRect();
	for (let gx = -0.5; gx <= 0.5; gx += 0.06) {
		for (let gy = -0.5; gy <= 0.5; gy += 0.06) {
			ray.setFromCamera(new THREE.Vector2(gx, gy), v.defaultCamera);
			const h = ray.intersectObjects(targets, false);
			if (h.length) {
				return {
					x: rect.left + (gx * 0.5 + 0.5) * rect.width,
					y: rect.top + (-gy * 0.5 + 0.5) * rect.height,
					name: h[0].object.name,
				};
			}
		}
	}
	return null;
});
if (clickTarget) {
	await page.click('#anno-add');
	await page.mouse.click(clickTarget.x, clickTarget.y);
	await page.waitForTimeout(400);
	const afterClick = await page.evaluate(() => ({
		count: window.VIEWER.app.studio.annotations.items.length,
		title: window.VIEWER.app.studio.annotations.items[0]?.title,
		picking: window.VIEWER.app.studio.annotations.picking,
	}));
	check(
		'真实鼠标点选放置标注',
		afterClick.count === 1 && !afterClick.picking,
		`命中「${clickTarget.name}」→ 标注「${afterClick.title}」，点选模式已退出`,
	);
} else {
	check('真实鼠标点选放置标注', false, '未找到可点击的模型像素');
}
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '03-annotation.png') });

// 7. 测量
const meas = await page.evaluate(() => {
	const studio = window.VIEWER.app.studio;
	const viewer = window.VIEWER.app.viewer;
	const THREE = window.THREE;
	const ray = new THREE.Raycaster();
	const targets = [];
	viewer.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
	});
	const pts = [];
	// 取两个"落在模型主体上"的点：先收集所有命中，再挑离屏幕中心较近的两个，
	// 避免量到画面边缘的零散零件、标注线跑到画外。
	const allHits = [];
	for (let gx = -0.6; gx <= 0.6; gx += 0.08) {
		for (let gy = -0.6; gy <= 0.6; gy += 0.08) {
			ray.setFromCamera(new THREE.Vector2(gx, gy), viewer.defaultCamera);
			const h = ray.intersectObjects(targets, false);
			if (h.length) allHits.push({ gx, gy, point: h[0].point.clone(), name: h[0].object.name });
		}
	}
	if (allHits.length < 2) return { ok: false, n: allHits.length };
	// 取两个分处上下、且 x 接近的命中点，量出的线段基本竖直、易读
	const sorted = allHits.sort((a, b) => a.gy - b.gy);
	const low = sorted[0];
	const high = sorted[sorted.length - 1];
	pts.push(low.point, high.point);
	if (pts.length < 2) return { ok: false, n: pts.length };
	studio.measure.commit(pts[0], pts[1]);
	studio.measure.layout();
	const label = document.querySelector('.measure-label');
	return {
		ok: true,
		text: label ? label.textContent : null,
		dist: studio.measure.measurements[0].dist,
	};
});
check(
	'测距计算与标签',
	meas.ok && Boolean(meas.text),
	`距离=${meas.dist ? meas.dist.toFixed(3) : '-'} 标签=${meas.text || '-'}`,
);
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT, '04-measure.png') });

// 8. 项目序列化往返
const proj = await page.evaluate(() => {
	const app = window.VIEWER.app;
	const { serializeProject } = window.__studioProject || {};
	return null;
});
const projData = await page.evaluate(() => {
	const app = window.VIEWER.app;
	// 走 Studio 实例方法（与「导出项目 JSON」按钮完全同一条代码路径），
	// 这样在 dev 和 build 产物下都能测，不依赖模块路径。
	const data = app.studio.serialize();
	return {
		schema: data.schema,
		annotations: data.annotations.length,
		sectionEnabled: data.section.enabled,
		explodeAmount: data.explode.amount,
		json: JSON.stringify(data).length,
	};
});
check(
	'项目序列化',
	projData.schema === 'gltf-studio/project' && projData.annotations > 0,
	`${projData.json} 字节, ${projData.annotations} 条标注`,
);

// 8b. 项目 JSON 往返：apply 后状态应能还原
const roundTrip = await page.evaluate(() => {
	const app = window.VIEWER.app;
	const before = app.studio.serialize();
	// 打乱当前状态
	app.studio.section.setAxis('z');
	app.studio.section.setPosition(0.11);
	app.studio.explode.setAmount(0);
	app.studio.annotations.clear();
	// 还原
	app.studio.apply(JSON.parse(JSON.stringify(before)));
	const after = app.studio.serialize();
	return {
		sameAxis: before.section.axis === after.section.axis,
		samePos: Math.abs(before.section.position - after.section.position) < 1e-6,
		sameAnno: before.annotations.length === after.annotations.length,
		annoTitle: after.annotations[0] && after.annotations[0].title,
	};
});
check(
	'项目 JSON 往返还原',
	roundTrip.sameAxis && roundTrip.samePos && roundTrip.sameAnno,
	`axis/position/annotations 均一致（标注标题「${roundTrip.annoTitle}」）`,
);

// 8c. 隔离：只保留目标子树，祖先几何应被幽灵化
const isolate = await page.evaluate(() => {
	const s = window.VIEWER.app.studio;
	const v = window.VIEWER.app.viewer;
	let target = null;
	v.content.traverse((n) => {
		if (n.name === 'arm_upper') target = n;
	});
	if (!target) return { ok: false };
	s.isolate(target);
	const visibleMeshes = [];
	v.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) {
			// 幽灵材质（colorWrite=false）不算"可见"
			const m = Array.isArray(n.material) ? n.material[0] : n.material;
			if (m && m.colorWrite !== false) visibleMeshes.push(n.name);
		}
	});
	s.showAll();
	return { ok: true, visibleMeshes };
});
check(
	'隔离只保留目标子树',
	isolate.ok && !isolate.visibleMeshes.includes('base') && isolate.visibleMeshes.includes('arm_upper'),
	`可见零件：${isolate.visibleMeshes.join(', ')}`,
);

// 9. 性能：分三组对照 —— 空转基线 / 开剖切静止 / 拖动剖切滑块
// 只报"绝对值"没有意义，必须给出相对基线的增量，才能说明新功能的真实成本。
const gpuName = await page.evaluate(() => {
	const gl = window.VIEWER.app.viewer.renderer.getContext();
	const dbg = gl.getExtension('WEBGL_debug_renderer_info');
	return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
});

async function benchFrames(n = 150) {
	return page.evaluate(async (count) => {
		const times = [];
		let last = performance.now();
		return new Promise((resolve) => {
			let i = 0;
			const step = () => {
				const now = performance.now();
				times.push(now - last);
				last = now;
				i++;
				if (i < count) requestAnimationFrame(step);
				else {
					times.shift();
					const s = [...times].sort((a, b) => a - b);
					resolve({
						frames: times.length,
						avg: times.reduce((a, b) => a + b, 0) / times.length,
						p50: s[Math.floor(s.length * 0.5)],
						p95: s[Math.floor(s.length * 0.95)],
						max: s[s.length - 1],
					});
				}
			};
			requestAnimationFrame(step);
		});
	}, n);
}

// 基线：剖切关闭
await page.evaluate(() => window.VIEWER.app.studio.section.setEnabled(false));
await page.waitForTimeout(300);
const perfBaseline = await benchFrames();

// 开剖切但静止
await page.evaluate(() => window.VIEWER.app.studio.section.setEnabled(true));
await page.waitForTimeout(300);
const perfStatic = await benchFrames();

// 拖动剖切滑块（每帧改一次平面位置，最坏情况）
const perfDrag = await page.evaluate(async () => {
	const s = window.VIEWER.app.studio.section;
	const times = [];
	let last = performance.now();
	return new Promise((resolve) => {
		let i = 0;
		const step = () => {
			const now = performance.now();
			times.push(now - last);
			last = now;
			s.setPosition((Math.sin(i * 0.12) + 1) / 2);
			i++;
			if (i < 150) requestAnimationFrame(step);
			else {
				times.shift();
				const sorted = [...times].sort((a, b) => a - b);
				resolve({
					frames: times.length,
					avg: times.reduce((a, b) => a + b, 0) / times.length,
					p50: sorted[Math.floor(sorted.length * 0.5)],
					p95: sorted[Math.floor(sorted.length * 0.95)],
					max: sorted[sorted.length - 1],
				});
			}
		};
		requestAnimationFrame(step);
	});
});

const perf = { gpu: gpuName, baseline: perfBaseline, static: perfStatic, drag: perfDrag };
const overhead = perfDrag.p95 - perfBaseline.p95;

// 判定是否为软件渲染：SwiftShader 下基线本身就只有 ~30fps，
// 此时"必须 60fps"是无意义的断言，只看相对开销。
const isSoftware =
	/swiftshader|llvmpipe|software|basic render/i.test(gpuName) ||
	perfBaseline.avg > 25;

check(
	'剖切拖动性能（相对基线）',
	overhead < 6,
	`GPU=${gpuName.split('(')[1]?.split(')')[0] || gpuName} | 基线 p95=${perfBaseline.p95.toFixed(1)}ms → 拖动 p95=${perfDrag.p95.toFixed(1)}ms（+${overhead.toFixed(1)}ms）`,
);

if (isSoftware) {
	// 软件渲染环境：只断言"不比基线慢"，不要求绝对 60fps
	check(
		'剖切拖动不劣化基线（软件渲染环境）',
		perfDrag.avg <= perfBaseline.avg * 1.25,
		`软件渲染 ${gpuName.slice(0, 40)} | 基线 avg=${perfBaseline.avg.toFixed(1)}ms → 拖动 avg=${perfDrag.avg.toFixed(1)}ms`,
	);
} else {
	check(
		'剖切拖动达到 60fps',
		perfDrag.p95 < 20,
		`avg=${perfDrag.avg.toFixed(2)}ms p50=${perfDrag.p50.toFixed(2)}ms p95=${perfDrag.p95.toFixed(2)}ms max=${perfDrag.max.toFixed(2)}ms`,
	);
}

// 10. 响应式：390 宽
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(700);
const resp = await page.evaluate(() => {
	const panel = document.querySelector('.studio-panel');
	const r = panel.getBoundingClientRect();
	const canvas = window.VIEWER.app.viewer.renderer.domElement.getBoundingClientRect();
	return {
		panelWidth: r.width,
		panelBottom: Math.round(window.innerHeight - r.bottom),
		overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
		canvasW: Math.round(canvas.width),
	};
});
check(
	'390px 响应式无横向溢出',
	!resp.overflowX && resp.panelWidth <= 391,
	`panel=${resp.panelWidth}px bottom=${resp.panelBottom}px canvas=${resp.canvasW}px`,
);
await page.screenshot({ path: path.join(OUT, '05-mobile-390.png') });

await page.setViewportSize({ width: 768, height: 1024 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '06-tablet-768.png') });

await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: path.join(OUT, '07-desktop-1440.png') });

// 错误汇总
check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');

const failed = results.filter((r) => !r.ok);
console.log('\n==== 结果 ====');
console.log(`${results.length - failed.length}/${results.length} 通过`);
if (failed.length) console.log('失败项：', failed.map((f) => f.name).join(', '));

fs.writeFileSync(
	path.join(OUT, 'verify-report.json'),
	JSON.stringify({ base: BASE, results, perf, info, errors }, null, 2),
);

await browser.close();
process.exit(failed.length ? 1 : 0);
