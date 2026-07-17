export const iconNames = [
	'spark',
	'search',
	'bell',
	'home',
	'users',
	'globe',
	'msg',
	'bookmark',
	'list',
	'gear',
	'bolt',
	'plus',
	'reply',
	'boost',
	'star',
	'more',
	'image',
	'poll',
	'smile',
	'upload',
	'trend',
	'pulse',
	'sliders',
	'hash',
	'arrow',
	'arrowL',
	'arrowR',
	'ext',
	'info',
	'grip',
	'pencil',
	'lock',
	'spaceman',
	'planet',
	'comet',
	'chevDown'
] as const;

export type IconName = (typeof iconNames)[number];

type SvgNodeBase = {
	fill?: string;
	opacity?: string;
	stroke?: string;
	strokeWidth?: string;
	strokeLinecap?: 'round' | 'butt' | 'square';
	strokeLinejoin?: 'round' | 'miter' | 'bevel';
	strokeDasharray?: string;
	transform?: string;
};

export type SvgNode =
	| (SvgNodeBase & { tag: 'path'; d: string })
	| (SvgNodeBase & { tag: 'circle'; cx: string; cy: string; r: string })
	| (SvgNodeBase & { tag: 'rect'; x: string; y: string; width: string; height: string; rx?: string })
	| (SvgNodeBase & { tag: 'ellipse'; cx: string; cy: string; rx: string; ry: string });

export type IconDefinition = {
	viewBox: string;
	fill: string;
	nodes: SvgNode[];
};

export const icons: Record<IconName, IconDefinition> = {
	spark: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M19 5l-4 4M9 15l-4 4', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round' }
		]
	},
	search: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '11', cy: '11', r: '6', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M16 16l4 4', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	bell: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M6 17V11a6 6 0 0112 0v6l1.5 2h-15L6 17z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' },
			{ tag: 'path', d: 'M10 21h4', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	home: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M4 11l8-7 8 7v9a1 1 0 01-1 1h-4v-6h-6v6H5a1 1 0 01-1-1v-9z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	users: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '9', cy: '9', r: '3.5', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'circle', cx: '17', cy: '10', r: '2.5', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M3 19c0-3 3-5 6-5s6 2 6 5M15 19c0-2 2-3.5 4-3.5s2.5 1 2.5 2.5', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	globe: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '12', cy: '12', r: '8', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16', stroke: 'currentColor', strokeWidth: '1.5' }
		]
	},
	msg: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M4 6h16v11H8l-4 3V6z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	bookmark: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M6 4h12v17l-6-4-6 4V4z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	list: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M4 7h16M4 12h16M4 17h10', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	gear: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '12', cy: '12', r: '3', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	bolt: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	plus: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M12 5v14M5 12h14', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }
		]
	},
	reply: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M9 8H6v3M6 8c0 5 4 8 9 8h4M19 16l-3 3M19 16l-3-3', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	boost: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M4 8l3-3 3 3M7 5v9a2 2 0 002 2h7M20 16l-3 3-3-3M17 19v-9a2 2 0 00-2-2H8', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	star: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M12 3l2.6 5.8 6.4.6-4.8 4.4 1.4 6.2L12 16.8 6.4 20l1.4-6.2L3 9.4l6.4-.6L12 3z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	more: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '6', cy: '12', r: '1.5', fill: 'currentColor' },
			{ tag: 'circle', cx: '12', cy: '12', r: '1.5', fill: 'currentColor' },
			{ tag: 'circle', cx: '18', cy: '12', r: '1.5', fill: 'currentColor' }
		]
	},
	image: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'rect', x: '3', y: '5', width: '18', height: '14', rx: '1', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'circle', cx: '8', cy: '10', r: '1.5', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M3 17l5-5 4 4 3-3 6 6', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	poll: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M5 19V11M11 19V5M17 19v-6', stroke: 'currentColor', strokeWidth: '1.7', strokeLinecap: 'round' }
		]
	},
	smile: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '12', cy: '12', r: '8', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'circle', cx: '9', cy: '10', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '15', cy: '10', r: '1', fill: 'currentColor' },
			{ tag: 'path', d: 'M9 14c1 1.2 2 1.8 3 1.8s2-.6 3-1.8', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	upload: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M12 4v11M7 9l5-5 5 5M5 19h14', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	trend: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M3 17l6-6 4 4 8-9', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
			{ tag: 'path', d: 'M14 6h7v7', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	pulse: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M3 12h4l2-6 4 12 2-6h6', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	sliders: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M4 7h11M19 7h1M4 12h2M10 12h10M4 17h13M21 17h-1', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' },
			{ tag: 'circle', cx: '17', cy: '7', r: '2', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'circle', cx: '8', cy: '12', r: '2', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'circle', cx: '19', cy: '17', r: '2', stroke: 'currentColor', strokeWidth: '1.5' }
		]
	},
	hash: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M9 4l-2 16M17 4l-2 16M4 9h16M3 15h16', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	arrow: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M5 12h14M13 6l6 6-6 6', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	arrowL: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M15 6l-6 6 6 6', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	arrowR: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M9 6l6 6-6 6', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	ext: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M14 4h6v6M20 4l-8 8M10 6H5a1 1 0 00-1 1v12a1 1 0 001 1h12a1 1 0 001-1v-5', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' }
		]
	},
	info: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '12', cy: '12', r: '8', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M12 11v5M12 8v.5', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }
		]
	},
	grip: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '9', cy: '6', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '15', cy: '6', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '9', cy: '12', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '15', cy: '12', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '9', cy: '18', r: '1', fill: 'currentColor' },
			{ tag: 'circle', cx: '15', cy: '18', r: '1', fill: 'currentColor' }
		]
	},
	pencil: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M14 4l6 6L9 21H3v-6L14 4z', stroke: 'currentColor', strokeWidth: '1.5', strokeLinejoin: 'round' }
		]
	},
	lock: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'rect', x: '5', y: '11', width: '14', height: '9', rx: '1', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M8 11V8a4 4 0 018 0v3', stroke: 'currentColor', strokeWidth: '1.5' }
		]
	},
	spaceman: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '12', cy: '6', r: '3', stroke: 'currentColor', strokeWidth: '1.5' },
			{ tag: 'path', d: 'M9 9c-2 1-3 4-3 6h12c0-2-1-5-3-6M10 21v-6M14 21v-6', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round' }
		]
	},
	planet: {
		viewBox: '0 0 32 32',
		fill: 'none',
		nodes: [
			{ tag: 'circle', cx: '16', cy: '14', r: '6', stroke: '#a48bd9', strokeWidth: '1.4' },
			{ tag: 'ellipse', cx: '16', cy: '14', rx: '11', ry: '3', stroke: '#a48bd9', strokeWidth: '1.2', transform: 'rotate(-15 16 14)' },
			{ tag: 'circle', cx: '14', cy: '13', r: '0.8', fill: '#a48bd9' },
			{ tag: 'circle', cx: '18', cy: '15', r: '0.6', fill: '#a48bd9' }
		]
	},
	comet: {
		viewBox: '0 0 80 60',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M5 50 C 25 45, 45 25, 70 10', stroke: '#a48bd9', strokeWidth: '1.2', strokeDasharray: '2 3', strokeLinecap: 'round' },
			{ tag: 'circle', cx: '70', cy: '10', r: '2', fill: '#a48bd9' },
			{ tag: 'path', d: 'M68 8l-2 -3M72 8l2 -3M70 5v-3', stroke: '#a48bd9', strokeWidth: '1', strokeLinecap: 'round' }
		]
	},
	chevDown: {
		viewBox: '0 0 24 24',
		fill: 'none',
		nodes: [
			{ tag: 'path', d: 'M6 9l6 6 6-6', stroke: 'currentColor', strokeWidth: '1.6', strokeLinecap: 'round' }
		]
	}
};
