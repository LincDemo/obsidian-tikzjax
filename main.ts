import { Plugin, WorkspaceWindow } from 'obsidian';
import { TikzjaxPluginSettings, DEFAULT_SETTINGS, TikzjaxSettingTab } from "./settings";

import { optimize } from "./svgo.browser"; // 573KB
// @ts-ignore
import tikzjaxJs from 'inline:./tikzjax.js'; // 6.7MB


export default class TikzjaxPlugin extends Plugin {
	settings: TikzjaxPluginSettings;

	// #region Basic | 基础部分
	async onload() {
		await this.loadSettings();
		this.addSettingTab(new TikzjaxSettingTab(this.app, this));

		// Support pop-out windows | 支持弹出窗口
		this.app.workspace.onLayoutReady(() => {
			this.loadTikZJaxAllWindows();
			this.registerEvent(this.app.workspace.on("window-open", (win, window) => {
				this.loadTikZJax(window.document);
			}));
		});

		this.addSyntaxHighlighting();
		this.registerTikzCodeBlock();
	}

	onunload() {
		this.unloadTikZJaxAllWindows();

		this.removeSyntaxHighlighting();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
	// #endregion


	// #region CodeBlock About | 代码块相关
	/// 注册代码块类型：tikz
	registerTikzCodeBlock() {
		this.registerMarkdownCodeBlockProcessor("tikz", (source, el, ctx) => {
			// 渲染原理：使用 tikzjax 库，详见：https://github.com/kisonecat/tikzjax
			// 创建一个有原文本类型的代码script块，并填入内容，如：
			// <script type="text/tikz">
			// \begin{tikzpicture}
			// 	\draw (0,0) circle (1in);
			// \end{tikzpicture}
			// </script>
			// 等待其自动渲染并抛出 'tikzjax-load-finished' 事件
			const script = el.createEl("script");
			script.setAttribute("type", "text/tikz");
			script.setAttribute("data-show-console", "true");
			script.setText(this.registerTikzCodeBlock_tidyTikzSource(source));
		});
	}
	/// 规整化源码
	registerTikzCodeBlock_tidyTikzSource(tikzSource: string): string {

		// Remove non-breaking space characters, otherwise we get errors | 删除非换行空格字符，否则我们会得到错误
		const remove = "&nbsp;";
		tikzSource = tikzSource.replaceAll(remove, "");


		let lines = tikzSource.split("\n");

		// Trim whitespace that is inserted when pasting in code, otherwise TikZJax complains | 修剪粘贴代码时插入的空白，否则TikZJax会报错
		lines = lines.map(line => line.trim());

		// Remove empty lines | 删除空行
		lines = lines.filter(line => line);


		return lines.join("\n");
	}
	
	/// 添加代码块内语法高亮类型
	addSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo.push({name: "Tikz", mime: "text/x-latex", mode: "stex"});
	}
	removeSyntaxHighlighting() {
		// @ts-ignore
		window.CodeMirror.modeInfo = window.CodeMirror.modeInfo.filter(el => el.name != "Tikz");
	}
	// #endregion


	// #region Support pop-out windows | 弹出窗口相关
	// tikzijax完成渲染后会抛出 'tikzjax-load-finished' 事件
	loadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.loadTikZJax(window.document);
		}
	}
	loadTikZJax(doc: Document) {
		const s = document.createElement("script");
		s.id = "tikzjax";
		s.type = "text/javascript";
		s.innerText = tikzjaxJs;
		doc.body.appendChild(s);

		doc.addEventListener('tikzjax-load-finished', this.postProcessSvg);
	}
	unloadTikZJaxAllWindows() {
		for (const window of this.getAllWindows()) {
			this.unloadTikZJax(window.document);
		}
	}
	unloadTikZJax(doc: Document) {
		const s = doc.getElementById("tikzjax");
		s.remove();

		doc.removeEventListener("tikzjax-load-finished", this.postProcessSvg);
	}
	getAllWindows() {
		// Via https://discord.com/channels/686053708261228577/840286264964022302/991591350107635753

		const windows = [];
		
		// push the main window's root split to the list | 将主窗口的根分割推到列表中
		windows.push(this.app.workspace.rootSplit.win);
		
		// @ts-ignore floatingSplit is undocumented
		const floatingSplit = this.app.workspace.floatingSplit;
		floatingSplit.children.forEach((child: any) => {
			// if this is a window, push it to the list | 如果这是一个窗口，把它推到列表中
			if (child instanceof WorkspaceWindow) {
				windows.push(child.win);
			}
		});

		return windows;
	}
	// #endregion


	// #region postProcessSvg | 后处理SVG
	postProcessSvg(e: Event) {
	
		const svgEl = e.target as HTMLElement;
		let svg = svgEl.outerHTML;

		if (this.settings.invertColorsInDarkMode) {
			svg = this.postProcessSvg_colorSVGinDarkMode(svg);
		}

		svg = this.postProcessSvg_optimizeSVG(svg);

		svgEl.outerHTML = svg;
	}
	/// 后处理SVG - 修复明暗模式下的显示问题
	postProcessSvg_colorSVGinDarkMode(svg: string) {
		// Replace the color "black" with currentColor (the current text color) | 用currentColor（当前文本颜色）替换黑色
		// so that diagram axes, etc are visible in dark mode | 因此，图表轴等在暗模式下是可见的
		// And replace "white" with the background color | 将“白色”替换为背景色

		svg = svg.replaceAll(/("#000"|"black")/g, `"currentColor"`)
				.replaceAll(/("#fff"|"white")/g, `"var(--background-primary)"`);

		return svg;
	}
	/// 后处理SVG - 其他SVG优化
	postProcessSvg_optimizeSVG(svg: string) {
		// Optimize the SVG using SVGO | 使用SVGO优化SVG
		// Fixes misaligned text nodes on mobile | 修复移动设备上不对齐的文本节点

		return optimize(svg, {plugins:
			[
				{
					name: 'preset-default',
					params: {
						overrides: {
							// Don't use the "cleanupIDs" plugin
							// To avoid problems with duplicate IDs ("a", "b", ...)
							// when inlining multiple svgs with IDs
							cleanupIDs: false
						}
					}
				}
			]
		// @ts-ignore
		}).data;
	}
	// #endregion
}
