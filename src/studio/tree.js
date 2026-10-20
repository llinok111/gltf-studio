/**
 * tree.js — 零件树（scene graph outline）
 *
 * 上游 viewer 只用 console.group 打印节点，用户看不到结构。本模块把它做成可交互面板：
 * - 层级折叠、显示/隐藏、单击隔离（isolate）、双击定位（frame）
 * - 搜索过滤
 * - 每个节点显示三角面数，方便定位"哪个零件吃性能"
 *
 * 纯 DOM 实现，不引入框架，避免为这点功能背一个 React 运行时。
 */
export class PartTree {
	/**
	 * @param {HTMLElement} rootEl
	 * @param {{ onSelect:(node:any)=>void, onVisibility:(node:any,visible:boolean)=>void, onIsolate:(node:any)=>void, onFrame:(node:any)=>void }} handlers
	 */
	constructor(rootEl, handlers = {}) {
		this.rootEl = rootEl;
		this.handlers = handlers;
		this.content = null;
		this.rows = [];
		this.filter = '';
		this.selected = null;

		this.listEl = document.createElement('div');
		this.listEl.className = 'ptree-list';
		this.rootEl.appendChild(this.listEl);

		this.statsEl = document.createElement('div');
		this.statsEl.className = 'ptree-stats';
		this.rootEl.appendChild(this.statsEl);
	}

	setContent(content) {
		this.listEl.innerHTML = '';
		this.rows = [];
		this.content = content;
		this.selected = null;
		if (!content) {
			this.statsEl.textContent = '';
			return;
		}

		content.updateMatrixWorld(true);
		const frag = document.createDocumentFragment();
		this.buildNode(content, 0, frag);
		this.listEl.appendChild(frag);
		this.updateStats();
	}

	/** 递归统计三角面 */
	countTriangles(node) {
		let tris = 0;
		node.traverse((n) => {
			if (n.isMesh && n.geometry) {
				const g = n.geometry;
				const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
				tris += Math.floor(count / 3);
			}
		});
		return tris;
	}

	buildNode(node, depth, frag) {
		if (node.userData && node.userData.__internal) return;
		// 跳过纯容器之外的空节点（无名字无子节点无几何）
		const isMesh = Boolean(node.isMesh);
		const hasKids = node.children.some((c) => !(c.userData && c.userData.__internal));

		const row = document.createElement('div');
		row.className = 'ptree-row';
		row.style.paddingLeft = `${8 + depth * 14}px`;
		row.dataset.depth = String(depth);

		const caret = document.createElement('button');
		caret.className = 'ptree-caret';
		caret.type = 'button';
		caret.setAttribute('aria-label', 'toggle');
		caret.textContent = hasKids ? '▾' : '';
		caret.disabled = !hasKids;
		row.appendChild(caret);

		const dot = document.createElement('span');
		dot.className = 'ptree-dot';
		dot.dataset.kind = isMesh ? 'mesh' : hasKids ? 'group' : 'node';
		row.appendChild(dot);

		const label = document.createElement('span');
		label.className = 'ptree-label';
		label.textContent = node.name || (isMesh ? '(unnamed mesh)' : '(unnamed group)');
		label.title = label.textContent;
		row.appendChild(label);

		if (isMesh) {
			const tris = this.countTriangles(node);
			const badge = document.createElement('span');
			badge.className = 'ptree-tris';
			badge.textContent = formatCount(tris);
			row.appendChild(badge);
		}

		const eye = document.createElement('button');
		eye.className = 'ptree-eye';
		eye.type = 'button';
		eye.title = '显示 / 隐藏';
		eye.setAttribute('aria-label', 'toggle visibility');
		eye.textContent = node.visible ? '●' : '○';
		eye.addEventListener('click', (e) => {
			e.stopPropagation();
			node.visible = !node.visible;
			eye.textContent = node.visible ? '●' : '○';
			row.classList.toggle('is-hidden', !node.visible);
			this.handlers.onVisibility && this.handlers.onVisibility(node, node.visible);
		});
		row.appendChild(eye);

		row.addEventListener('click', () => {
			this.select(node, row);
			this.handlers.onSelect && this.handlers.onSelect(node);
		});
		row.addEventListener('dblclick', () => {
			this.handlers.onFrame && this.handlers.onFrame(node);
		});

		// 右键菜单：隔离
		row.addEventListener('contextmenu', (e) => {
			e.preventDefault();
			this.handlers.onIsolate && this.handlers.onIsolate(node);
		});

		this.rows.push({ node, row, depth, label, parent: node.parent });
		frag.appendChild(row);

		if (hasKids) {
			const childWrap = document.createDocumentFragment();
			let count = 0;
			node.children.forEach((child) => {
				if (child.userData && child.userData.__internal) return;
				this.buildNode(child, depth + 1, childWrap);
				count++;
			});
			row.dataset.childCount = String(count);
			frag.appendChild(childWrap);

			caret.addEventListener('click', (e) => {
				e.stopPropagation();
				const collapsed = row.classList.toggle('is-collapsed');
				caret.textContent = collapsed ? '▸' : '▾';
				// 折叠时隐藏所有更深层且未被子节点展开的行
				this.applyCollapse();
			});
		}
	}

	applyCollapse() {
		// 依据折叠状态重算可见性
		const collapsedRows = this.rows.filter((r) => r.row.classList.contains('is-collapsed'));
		this.rows.forEach((r) => {
			let hidden = false;
			for (const c of collapsedRows) {
				if (r.depth > c.depth && this.isDescendantRow(r, c)) {
					hidden = true;
					break;
				}
			}
			r.row.classList.toggle('is-collapsed-hidden', hidden);
		});
		this.applyFilter();
	}

	isDescendantRow(row, ancestorRow) {
		// rows 按 DFS 顺序排列：ancestor 之后、深度回落到 <= ancestor.depth 之前的都是后代
		const i = this.rows.indexOf(ancestorRow);
		const j = this.rows.indexOf(row);
		if (i < 0 || j <= i) return false;
		for (let k = i + 1; k < j; k++) {
			if (this.rows[k].depth <= ancestorRow.depth) return false;
		}
		return true;
	}

	select(node, row) {
		this.rows.forEach((r) => r.row.classList.remove('is-selected'));
		if (row) row.classList.add('is-selected');
		this.selected = node;
	}

	setFilter(text) {
		this.filter = (text || '').trim().toLowerCase();
		this.applyFilter();
	}

	applyFilter() {
		if (!this.filter) {
			this.rows.forEach((r) => r.row.classList.remove('is-filtered-out'));
			return;
		}
		// 命中节点及其祖先都保留
		const keep = new Set();
		this.rows.forEach((r) => {
			const name = (r.node.name || '').toLowerCase();
			if (name.includes(this.filter)) {
				keep.add(r);
				// 祖先链
				let p = r.node.parent;
				while (p && p !== this.content) {
					const prow = this.rows.find((x) => x.node === p);
					if (prow) keep.add(prow);
					p = p.parent;
				}
			}
		});
		this.rows.forEach((r) => {
			r.row.classList.toggle('is-filtered-out', !keep.has(r));
		});
	}

	updateStats() {
		if (!this.content) return;
		let meshes = 0;
		let tris = 0;
		let materials = new Set();
		this.content.traverse((n) => {
			if (n.isMesh && n.geometry) {
				meshes++;
				const g = n.geometry;
				const count = g.index ? g.index.count : g.attributes.position ? g.attributes.position.count : 0;
				tris += Math.floor(count / 3);
				const mats = Array.isArray(n.material) ? n.material : [n.material];
				mats.forEach((m) => m && materials.add(m.uuid));
			}
		});
		this.statsEl.innerHTML = `
			<span><b>${meshes}</b> meshes</span>
			<span><b>${formatCount(tris)}</b> tris</span>
			<span><b>${materials.size}</b> materials</span>
		`;
	}

	/** 同步可见性状态到 UI（隔离/全部显示后调用） */
	syncVisibility() {
		this.rows.forEach((r) => {
			const eye = r.row.querySelector('.ptree-eye');
			if (eye) eye.textContent = r.node.visible ? '●' : '○';
			r.row.classList.toggle('is-hidden', !r.node.visible);
		});
	}
}

function formatCount(n) {
	if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
	return String(n);
}
