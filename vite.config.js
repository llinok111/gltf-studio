import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * 把 assets/ 原样复制到 dist/assets/。
 *
 * 上游 package.json 里写了 staticFiles 配置，但那是
 * vite-plugin-static-copy 的字段，而项目并没有安装该插件 ——
 * 于是 `npm run build` 产出的 dist 里根本没有示例模型，
 * 生产环境下 `?model=/assets/models/xxx.glb` 会命中 SPA fallback，
 * 返回 index.html，GLTFLoader 解析 HTML 时报
 * "Unexpected token '<' ... is not valid JSON"。
 *
 * 这里用一个极小的内联插件替代，避免多引一个依赖。
 */
function copyAssets() {
	return {
		name: 'copy-assets',
		apply: 'build',
		closeBundle() {
			const src = resolve(process.cwd(), 'assets');
			const dest = resolve(process.cwd(), 'dist', 'assets');
			if (!existsSync(src)) return;
			mkdirSync(dest, { recursive: true });
			cpSync(src, dest, { recursive: true });
		},
	};
}

export default defineConfig({
	plugins: [copyAssets()],
	build: {
		// three.js 本身就有 600KB+，单 chunk 是上游的既有形态，
		// 这里只把告警阈值调高，不做代码分割（避免破坏上游的同步加载假设）。
		chunkSizeWarningLimit: 1600,
	},
	server: {
		port: 3000,
	},
});
