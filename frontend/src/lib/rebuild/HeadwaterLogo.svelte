<script lang="ts">
	type Props = {
		label?: string;
	};

	let { label }: Props = $props();
</script>

<svg
	viewBox="0 0 100 100"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	<g fill="none" stroke="#00145f" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
		<circle cx="50" cy="26" r="7.2" />
		<path d="M14 39 C31 34 46 40 46 60 V77" />
		<path d="M86 39 C69 34 54 40 54 60 V77" />
		<path d="M11 55 C25 45 39 50 39 64 V77" />
		<path d="M89 55 C75 45 61 50 61 64 V77" />
	</g>
</svg>
