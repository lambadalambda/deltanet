<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<svg width="0" height="0" class="duotone-filter-defs" aria-hidden="true" focusable="false">
	<defs>
		<filter id="duotoneCream" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0.165 0.961" />
				<feFuncG type="table" tableValues="0.145 0.945" />
				<feFuncB type="table" tableValues="0.125 0.910" />
			</feComponentTransfer>
		</filter>
		<filter id="duotoneDusk" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0.102 0.906" />
				<feFuncG type="table" tableValues="0.078 0.659" />
				<feFuncB type="table" tableValues="0.180 0.788" />
			</feComponentTransfer>
		</filter>
		<filter id="duotoneDrive" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0.027 0.490" />
				<feFuncG type="table" tableValues="0.035 0.769" />
				<feFuncB type="table" tableValues="0.102 0.745" />
			</feComponentTransfer>
		</filter>
		<filter id="duotoneSimoun" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0.094 0.910" />
				<feFuncG type="table" tableValues="0.125 0.463" />
				<feFuncB type="table" tableValues="0.247 0.227" />
			</feComponentTransfer>
		</filter>
		<filter id="duotoneLabLight" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0 1" />
				<feFuncG type="table" tableValues="0.443 1" />
				<feFuncB type="table" tableValues="0.663 1" />
			</feComponentTransfer>
		</filter>
		<filter id="duotoneLabDark" color-interpolation-filters="sRGB">
			<feColorMatrix type="matrix" values="0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0" />
			<feComponentTransfer>
				<feFuncR type="table" tableValues="0.039 0.302" />
				<feFuncG type="table" tableValues="0.055 0.722" />
				<feFuncB type="table" tableValues="0.071 0.910" />
			</feComponentTransfer>
		</filter>
	</defs>
</svg>

{@render children()}
