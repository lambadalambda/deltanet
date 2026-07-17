<script lang="ts">
	import PetnameChip from './PetnameChip.svelte';
	import { profileHref } from './profile-links';

	type Props = {
		addressees?: string[];
		/** Addressee handle (lowercased) -> their chosen name (Headwater mentions). */
		addresseeNames?: Record<string, string>;
		/** Addressee handle (lowercased) -> my local petname (Headwater mentions). */
		addresseePetnames?: Record<string, string>;
		focused?: boolean;
	};

	let { addressees = [], addresseeNames = {}, addresseePetnames = {}, focused = false }: Props = $props();

	const petnameFor = (address: string) => addresseePetnames[address.trim().toLowerCase()];
	let parent = $derived(addressees[0]);
	let cc = $derived(addressees.slice(1));

	// Chatmail local parts are random registration strings, so a chip shows the
	// author's chosen display name when the status's mentions carry one; the
	// full handle stays available as the chip's title/tooltip.
	const chipLabel = (address: string) =>
		addresseeNames[address.trim().toLowerCase()] ?? shortHandle(address);

	const shortHandle = (address: string) => {
		const trimmed = address.trim();
		if (!trimmed.startsWith('@')) return trimmed;

		const domainAt = trimmed.indexOf('@', 1);
		return domainAt === -1 ? trimmed : trimmed.slice(0, domainAt);
	};
</script>

{#if parent}
	<div class="post-pinged {focused ? 'focused-pinged' : ''}">
		<span class="post-pinged-l">Replying to</span>
		<span class="post-pinged-list">
			<a class="post-pinged-chip-parent" title={parent} aria-label={`Open profile for ${parent}`} href={profileHref(parent) ?? undefined}>
				<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="10" height="10" aria-hidden="true">
					<path d="M6 4L2 8l4 4" />
					<path d="M2 8h7a4 4 0 014 4v1" />
				</svg>
				<span class="post-pinged-handle">{chipLabel(parent)}</span>
			</a>
			{#if petnameFor(parent)}<PetnameChip petname={petnameFor(parent)!} />{/if}
			{#if cc.length > 0}
				<span class="post-pinged-also">· also</span>
			{/if}
			{#each cc as address}
				<a class="post-pinged-chip" title={address} aria-label={`Open profile for ${address}`} href={profileHref(address) ?? undefined}>{chipLabel(address)}</a>
			{/each}
		</span>
	</div>
{/if}
