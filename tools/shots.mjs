/**
 * tools/shots.mjs — 生成交付用截图
 *
 * 与 verify.mjs 的分工：
 * - verify.mjs 负责"断言"，只截关键状态作为证据；
 * - 本脚本负责"展示"，每个功能都摆到最能说明问题的状态再拍。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5183/';
const OUT = path.resolve('shots');

// 标注文案（按零件名）
const NOTE = {
	base: '铝合金底板，四角橡胶减震脚',
	turret: '转台，内嵌 360° 回转驱动',
	arm_upper: '上臂壳体，包覆肩关节',
	finger_left: '两指夹爪（左），行程 34mm',
	foot_fl: '左前减震脚，可拆卸',
};

const browser = await chromium.launch({
	args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

async function shot(page, name) {
	await page.waitForTimeout(420);
	await page.screenshot({ path: path.join(OUT, name), animations: 'disabled' });
	console.log('  ✓', name);
}

// ---------------------------------------------------------------- 1. 空状态
{
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(1000);
	await shot(page, '00-landing.png');
	await page.close();
}

// ---------------------------------------------------------------- 主流程
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', e.message));
await page.goto(BASE + '?model=assets/models/RoboticArm.glb', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.VIEWER && window.VIEWER.scene, { timeout: 60000 });
await page.waitForTimeout(2200);

// 展开零件树（默认收起，截图要展示）
await page.click('.sp-sec:nth-of-type(5) .sp-h');
await page.waitForTimeout(300);

// 2. 整体视图 + 零件树
await shot(page, '01-overview.png');

// 3. 剖切：Y 轴 62%
await page.click('.sp-switch .sp-track');
await page.click('[data-axis="y"]');
await page.$eval('#sec-pos', (el) => {
	el.value = '0.62';
	el.dispatchEvent(new Event('input', { bubbles: true }));
});
await shot(page, '02-section-y.png');

// 4. 剖切：Z 轴，看到底座内部
await page.click('[data-axis="z"]');
await page.$eval('#sec-pos', (el) => {
	el.value = '0.52';
	el.dispatchEvent(new Event('input', { bubbles: true }));
});
await shot(page, '03-section-z.png');

// 关掉剖切，后续展示爆炸
await page.click('.sp-switch .sp-track');
await page.waitForTimeout(250);

// 5. 爆炸视图 100%
await page.click('#exp-toggle');
await page.waitForTimeout(1100);
await shot(page, '04-explode-radial.png');

// 6. 轴向爆炸（Y 轴分层）
await page.click('[data-emode="axis"]');
await page.waitForTimeout(900);
await shot(page, '05-explode-axis.png');

// 复位
await page.evaluate(() => {
	const e = window.VIEWER.app.studio.explode;
	e.setMode('radial');
	e.setAmount(0);
});
await page.click('[data-emode="radial"]');
await page.waitForTimeout(700);

// 7. 多标注
const annoInfo = await page.evaluate((NOTE) => {
	const s = window.VIEWER.app.studio;
	const v = window.VIEWER.app.viewer;
	const THREE = window.THREE;
	const ray = new THREE.Raycaster();
	const targets = [];
	v.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
	});

	// 对几个关键零件各打一条标注
	const wanted = ['base', 'turret', 'arm_upper', 'finger_left', 'foot_fl'];
	const placed = [];
	for (const name of wanted) {
		const mesh = targets.find((t) => t.name === name);
		if (!mesh) continue;
		// 用零件包围盒中心 + 朝向相机方向找表面点
		const box = new THREE.Box3().setFromObject(mesh);
		const c = box.getCenter(new THREE.Vector3());
		const dir = v.defaultCamera.position.clone().sub(c).normalize();
		ray.set(c, dir);
		ray.far = 100;
		const h = ray.intersectObject(mesh, false);
		const p = h.length ? h[0].point : c;
		s.annotations.add({
			point: p.clone(),
			title: name,
			body: NOTE[name] || '',
		});
		placed.push(name);
	}
	s.annotations.layout();
	return { placed: placed.length, names: placed };
}, NOTE);
console.log('  标注:', annoInfo.names.join(', '));
await shot(page, '06-annotations.png');

// 8. 测量
await page.evaluate(() => {
	const s = window.VIEWER.app.studio;
	const v = window.VIEWER.app.viewer;
	const THREE = window.THREE;
	const ray = new THREE.Raycaster();
	const targets = [];
	v.content.traverse((n) => {
		if (n.isMesh && n.visible && !(n.userData && n.userData.__internal)) targets.push(n);
	});
	// 量底板宽度：左右两个底脚
	const fl = targets.find((t) => t.name === 'foot_fl');
	const fr = targets.find((t) => t.name === 'foot_fr');
	if (fl && fr) {
		const a = new THREE.Box3().setFromObject(fl).getCenter(new THREE.Vector3());
		const b = new THREE.Box3().setFromObject(fr).getCenter(new THREE.Vector3());
		s.measure.commit(a, b);
	}
	// 再量一次总高：底座中心 → 上臂顶端
	const base = targets.find((t) => t.name === 'base');
	const arm = targets.find((t) => t.name === 'finger_left');
	if (base && arm) {
		const a = new THREE.Box3().setFromObject(base).getCenter(new THREE.Vector3());
		const b = new THREE.Box3().setFromObject(arm).getCenter(new THREE.Vector3());
		s.measure.commit(a, b);
	}
	s.measure.layout();
});
await page.click('.sp-sec:nth-of-type(4) .sp-h');
await page.waitForTimeout(300);
await shot(page, '07-measure.png');

// 9. 隔离：只看上臂组
await page.evaluate(() => {
	const s = window.VIEWER.app.studio;
	const v = window.VIEWER.app.viewer;
	let target = null;
	v.content.traverse((n) => {
		if (n.name === 'arm_upper') target = n;
	});
	if (target) s.isolate(target);
	s.partTree.syncVisibility();
});
await page.waitForTimeout(400);
await shot(page, '08-isolate.png');

await page.evaluate(() => window.VIEWER.app.studio.showAll());
await page.close();

// ---------------------------------------------------------------- 响应式
for (const [w, h, name] of [
	[1024, 768, '09-tablet-1024.png'],
	[768, 1024, '10-tablet-768.png'],
	[390, 844, '11-mobile-390.png'],
]) {
	const p2 = await browser.newPage({ viewport: { width: w, height: h } });
	await p2.goto(BASE + '?model=assets/models/RoboticArm.glb', { waitUntil: 'networkidle' });
	await p2.waitForFunction(() => window.VIEWER && window.VIEWER.scene, { timeout: 60000 });
	await p2.waitForTimeout(2000);
	// 移动端展示剖切 + 抽屉
	if (w <= 768) {
		await p2.evaluate(() => {
			const s = window.VIEWER.app.studio.section;
			s.setEnabled(true);
			s.setAxis('y');
			s.setPosition(0.62);
		});
	}
	await shot(p2, name);
	await p2.close();
}

await browser.close();
console.log('\n完成，截图在', OUT);
