const legacyClipboardWrite = (text: string): boolean => {
	const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	const textarea = document.createElement('textarea');
	textarea.value = text;
	textarea.setAttribute('readonly', '');
	textarea.setAttribute('aria-hidden', 'true');
	textarea.style.position = 'fixed';
	textarea.style.left = '-9999px';
	document.body.appendChild(textarea);
	try {
		textarea.focus({ preventScroll: true });
		textarea.select();
		return document.execCommand('copy');
	} catch {
		return false;
	} finally {
		textarea.remove();
		if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
	}
};

export const writeClipboardText = async (text: string): Promise<void> => {
	if (window.headwaterDesktop?.writeClipboardText) {
		await window.headwaterDesktop.writeClipboardText(text);
		return;
	}
	if (legacyClipboardWrite(text)) return;
	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return;
	}
	throw new Error('copy failed');
};
