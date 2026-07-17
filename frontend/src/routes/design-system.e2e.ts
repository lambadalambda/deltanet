import { expect, test } from '@playwright/test';
import { expectNoHorizontalOverflow, setViewport } from '../test/playwright';

test('shows converted canonical design-system sections and switches themes', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	await expect(page).toHaveTitle('Headwater · Design System');
	await expect(page.getByRole('heading', { name: 'Foundations' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Iconography' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Posts' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Thread' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Radio · PN.fm' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Oekaki' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Surfaces' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Navigation' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Mobile' })).toBeVisible();
	await expect(page.locator('.ds-nav-foot')).toContainText('19 shared primitives');

	await expect(page.locator('#controls')).toContainText('Button · primary');
	await expect(page.locator('#attachments')).toContainText('pickAttachmentLayout →');
	await expect(page.locator('#attachments')).toContainText('Single media (1 attachment of any kind)');
	await expect(page.locator('#composer')).toContainText('Composer · with CW input');
	await expect(page.locator('#posts')).toContainText('Quoted posts');
	await expect(page.locator('#thread')).toContainText('AncestorPost → FocusedPost → ReplyPost');
	await expect(page.locator('#profile')).toContainText('ProfileView → ProfileSideRail');
	await expect(page.locator('#notifications')).toContainText('NotifRow k-mention unread');
	await expect(page.locator('#radio')).toContainText('Radio · Now playing tab');
	await expect(page.locator('#oekaki')).toContainText('Tool rail');
	await expect(page.locator('#surfaces')).toContainText('TrendsCard');
	await expect(page.locator('#navigation')).toContainText('ProfileMini');
	await expect(page.locator('#mobile')).toContainText('Home · feed + bottom tab bar');

	await page.getByRole('button', { name: 'Simoun' }).click();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'simoun');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical composer content-warning specimen', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const composer = page.locator('#composer');
	await expect(composer).toContainText('both panels persist as `composer.cw` and `composer.poll` state, attached on Post');
	await expect(composer.getByText('Composer · idle')).toBeVisible();
	await expect(composer.getByText('Composer · with CW input')).toBeVisible();
	await expect(composer.getByText('Composer · with poll editor')).toBeVisible();
	await expect(composer.getByText('Composer · CW + poll together')).toBeVisible();
	await expect(composer.getByText('Dropzone V1 · drag-over')).toBeVisible();
	await expect(composer.getByText('Dropzone V1 · uploading')).toBeVisible();
	await expect(composer.getByText('Dropzone V2 · idle · recommended')).toBeVisible();
	await expect(composer.getByText('Dropzone V2 · drag-over')).toBeVisible();
	await expect(composer.getByText('Dropzone V2 · rejected file')).toBeVisible();
	await expect(composer.getByText('Editor · with inserted pill')).toBeVisible();
	await expect(composer.getByText('Dropdown · open mid-type')).toBeVisible();
	await expect(composer.getByText(':shortcode: dropdown')).toBeVisible();
	await expect(composer.getByText('Full emoji picker')).toBeVisible();
	const cwSpec = composer.locator('.ds-spec').filter({ hasText: 'Composer · with CW input' });
	await expect(cwSpec.locator('.composer-cw')).toBeVisible();
	await expect(cwSpec.locator('.composer-cw-l')).toContainText('CW');
	await expect(cwSpec.locator('.composer-cw')).toHaveCSS('margin-left', '0px');
	await expect(cwSpec.locator('.composer-cw-l')).toHaveCSS('color', 'rgb(138, 106, 48)');
	await expect(cwSpec.getByRole('textbox', { name: 'Content warning text' })).toHaveAttribute('placeholder', 'One short line · what readers see before opening');
	await expect(cwSpec.getByRole('button', { name: 'CW' })).toHaveAttribute('aria-pressed', 'true');

	await cwSpec.getByRole('button', { name: 'Remove content warning' }).click();
	await expect(cwSpec.locator('.composer-cw')).toHaveCount(0);
	await expect(cwSpec.getByRole('button', { name: 'CW' })).toHaveAttribute('aria-pressed', 'false');

	await setViewport(page, 'mobile');
	await cwSpec.getByRole('button', { name: 'CW' }).click();
	await expect(cwSpec.locator('.composer-cw')).toBeVisible();
	await expectNoHorizontalOverflow(page);

	await setViewport(page, 'desktop');
	const pollSpec = composer.locator('.ds-spec').filter({ hasText: 'Composer · with poll editor' });
	await expect(pollSpec.locator('.composer-poll')).toBeVisible();
	await expect(pollSpec.locator('.composer-poll')).toHaveCSS('margin-left', '0px');
	await expect(pollSpec.locator('.composer-poll-head')).toContainText('Poll · 2–6 choices');
	await expect(pollSpec.getByRole('textbox', { name: 'Poll choice 1' })).toHaveValue('warm cassette');
	await expect(pollSpec.getByRole('textbox', { name: 'Poll choice 3' })).toHaveValue('spinning vinyl');
	await expect(pollSpec.locator('.ds-spec-note')).toHaveText('composer.poll · 2–6 choices · drag handles, duration, single/multi');
	await expect(pollSpec.getByLabel('Duration')).toHaveValue('24h');
	await expect(pollSpec.getByLabel('Voting')).toHaveValue('single');
	await expect(pollSpec.getByRole('button', { name: 'Poll', exact: true })).toHaveAttribute('aria-pressed', 'true');
	await expect(pollSpec.getByRole('button', { name: 'Hide totals until poll ends' })).toHaveAttribute('aria-pressed', 'true');
	await pollSpec.getByRole('button', { name: 'Add choice' }).click();
	await expect(pollSpec.getByRole('textbox', { name: 'Poll choice 4' })).toBeVisible();
	await pollSpec.getByRole('button', { name: 'Remove choice 4' }).click();
	await expect(pollSpec.getByRole('textbox', { name: 'Poll choice 4' })).toHaveCount(0);

	const combinedSpec = composer.locator('.ds-spec').filter({ hasText: 'Composer · CW + poll together' });
	await expect(combinedSpec.locator('.composer-cw')).toBeVisible();
	await expect(combinedSpec.locator('.composer-poll')).toBeVisible();
	await expect(combinedSpec.locator('.ds-spec-note')).toHaveText('both panels stack');
	await expect(combinedSpec.getByRole('button', { name: 'CW' })).toHaveAttribute('aria-pressed', 'true');
	await expect(combinedSpec.getByRole('button', { name: 'Poll', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('renders canonical composer mention and emoji autocomplete specimen', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const composer = page.locator('#composer');
	await expect(composer).toContainText('@mention & :shortcode: autocomplete');
	const insertedPillSpec = composer.locator('.ds-spec').filter({ hasText: 'Editor · with inserted pill' });
	await expect(insertedPillSpec.locator('.me-pill img[alt="soft.hertz ✦ avatar"]')).toBeVisible();
	const specimen = composer.locator('.ds-spec').filter({ hasText: 'Interactive editor · autocomplete' }).last();
	const editor = specimen.getByRole('textbox', { name: 'Post text' });

	await editor.click();
	await editor.pressSequentially('@so', { delay: 20 });
	await expect(specimen.getByRole('listbox', { name: 'Mention suggestions' })).toBeVisible();
	await expect(specimen.getByRole('option', { name: /soft.hertz/ })).toBeVisible();
	await expect(specimen.locator('img[alt="soft.hertz ✦ avatar"]').first()).toBeVisible();
	await editor.press('Tab');
	await expect(editor).toContainText('@soft.hertz');
	await expect(editor.locator('.me-pill img[alt="soft.hertz ✦ avatar"]')).toBeVisible();
	await expect(specimen.locator('[data-serialized-text]')).toContainText('@soft.hertz@kolektiva.social');

	await editor.pressSequentially(' :bl');
	await expect(specimen.getByRole('listbox', { name: 'Emoji suggestions' })).toBeVisible();
	await expect(specimen.getByRole('option', { name: /:blobcat:/ })).toBeVisible();
	await expect(specimen.getByRole('option', { name: /:blobcat:/ }).locator('img[alt=":blobcat:"]')).toBeVisible();
	await editor.press('Enter');
	await expect(editor.locator('.me-emoji img[alt=":blobcat:"]')).toBeVisible();
	await expect(specimen.locator('[data-serialized-text]')).toContainText(':blobcat:');
});

test('renders canonical surface and right-rail card specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const surfaces = page.locator('#surfaces');
	await expect(surfaces.getByText('TrendsCard')).toBeVisible();
	await expect(surfaces.getByRole('button', { name: /#fediverse/ })).toBeVisible();
	await expect(surfaces.getByText('WhoToFollow')).toBeVisible();
	await expect(surfaces.getByText('nyan.binary')).toBeVisible();
	await expect(surfaces.getByText('ShortcutsCard')).toBeVisible();
	await expect(surfaces.getByRole('button', { name: /Compose new post/ })).toBeVisible();
	await expect(surfaces.getByText('InstanceStatus')).toBeVisible();
	await expect(surfaces.getByText('headwater.example', { exact: true })).toBeVisible();
	await expect(surfaces.getByText('QuickSearchCard')).toBeVisible();
	await expect(surfaces.getByRole('button', { name: /Search hashtags/ })).toBeVisible();
	await expect(surfaces.getByText('FooterCard')).toBeVisible();
	await expect(surfaces.getByText('HEADWATER™ 2.4.58')).toBeVisible();
	await expect(surfaces.getByText('ProfilePreviewCard')).toBeVisible();
	await expect(surfaces.getByText('@dreambyte@headwater.example')).toBeVisible();
	await expect(surfaces.getByText('ProfileTipsCard')).toBeVisible();
	await expect(surfaces.getByText('Your avatar will be shown at 96×96px.')).toBeVisible();

	await surfaces.getByRole('button', { name: 'Follow' }).first().click();
	await expect(surfaces.getByRole('button', { name: 'Following' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('renders canonical navigation specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const navigation = page.locator('#navigation');
	await expect(navigation.getByText('ProfileMini')).toBeVisible();
	await expect(navigation.getByText('dreambyte', { exact: true })).toBeVisible();
	await expect(navigation.getByText('@dreambyte@pleroma.social')).toBeVisible();
	await expect(navigation.getByText('living in a soft world')).toBeVisible();
	await expect(navigation.getByText('pacific hour')).toBeVisible();
	await expect(navigation.getByText('Followers')).toBeVisible();
	await expect(navigation.getByText('SideNav (placeholder)')).toBeVisible();
	await expect(navigation.getByRole('button', { name: /^Home/ })).toBeVisible();
	await expect(navigation.getByRole('button', { name: /^Notifications/ })).toContainText('3');
	await expect(navigation.getByRole('button', { name: /^Settings/ })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('renders canonical mobile phone previews', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const mobile = page.locator('#mobile');
	await expect(mobile.getByText('Home · feed + bottom tab bar')).toBeVisible();
	await expect(mobile.getByText('Drawer · left side menu')).toBeVisible();
	await expect(mobile.getByText('Thread · ancestor + focused')).toBeVisible();
	await expect(mobile.locator('.ds-phone')).toHaveCount(3);
	await expect(mobile.getByText('Headwater™').first()).toBeVisible();
	await expect(mobile.getByRole('button', { name: /^Explore/ })).toBeVisible();
	await expect(mobile.getByRole('button', { name: /^Alerts/ })).toContainText('3');
	await expect(mobile.getByText('@dreambyte@pleroma.social')).toBeVisible();
	await expect(mobile.getByRole('button', { name: /^Local/ })).toBeVisible();
	await expect(mobile.getByText('Thread', { exact: true })).toBeVisible();
	await expect(mobile.getByText('gridwave', { exact: true })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('opens the attachment lightbox from the design-system specimen', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	await page.locator('#attachments').getByRole('button', { name: 'Open lightbox →' }).click();
	const dialog = page.getByRole('dialog', { name: 'Attachment lightbox' });
	await expect(dialog).toBeVisible();
	await expect(page.getByText('1 of 5 · station platform at dusk')).toBeVisible();
	await expect(dialog.locator('.lightbox-photo')).toHaveCSS('filter', 'none');
	await dialog.getByRole('button', { name: 'Next' }).click();
	await dialog.getByRole('button', { name: 'Next' }).click();
	await expect(page.getByText('3 of 5 · door with cat')).toBeVisible();
	const bounds = await dialog.evaluate((node) => {
		const rect = (selector: string) => {
			const target = node.querySelector(selector);
			if (!target) return null;
			const box = target.getBoundingClientRect();
			return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
		};
		return {
			head: rect('.lightbox-head'),
			body: rect('.lightbox-body'),
			photo: rect('.lightbox-photo'),
			strip: rect('.lightbox-strip'),
			foot: rect('.lightbox-foot')
		};
	});
	expect(bounds.head).not.toBeNull();
	expect(bounds.body).not.toBeNull();
	expect(bounds.photo).not.toBeNull();
	expect(bounds.strip).not.toBeNull();
	expect(bounds.foot).not.toBeNull();
	expect(bounds.photo?.top ?? 0).toBeGreaterThanOrEqual(bounds.body?.top ?? 0);
	expect(bounds.photo?.bottom ?? 0).toBeLessThanOrEqual(bounds.body?.bottom ?? 0);
	expect(bounds.photo?.left ?? 0).toBeGreaterThanOrEqual(bounds.body?.left ?? 0);
	expect(bounds.photo?.right ?? 0).toBeLessThanOrEqual(bounds.body?.right ?? 0);
	expect(bounds.photo?.top ?? 0).toBeGreaterThanOrEqual(bounds.head?.bottom ?? 0);
	expect(bounds.photo?.bottom ?? 0).toBeLessThanOrEqual(bounds.strip?.top ?? bounds.foot?.top ?? 0);
	await expect(dialog.locator('.lightbox-photo')).toHaveCSS('object-fit', 'contain');
	const previousIsTopmost = await dialog.getByRole('button', { name: 'Previous' }).evaluate((button) => {
		const box = button.getBoundingClientRect();
		const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
		return target === button || button.contains(target);
	});
	expect(previousIsTopmost).toBe(true);
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(page.getByRole('dialog', { name: 'Attachment lightbox' })).toBeHidden();
});

test('renders canonical audio attachment specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const attachments = page.locator('#attachments');
	const singleAudio = attachments.locator('.ds-spec').filter({ hasText: "'single' → AudioAttachment" });
	const audioSource = singleAudio.locator('audio');
	const audioWaveform = singleAudio.getByRole('slider', { name: 'Seek audio' });
	await expect(singleAudio.locator('.post-audio')).toBeVisible();
	await expect(singleAudio.locator('.pa-cover-img')).toHaveAttribute('src', 'samples/encardia-99.png');
	await expect(audioWaveform).toBeVisible();
	await expect(singleAudio.locator('.pa-bar')).toHaveCount(56);
	await expect(singleAudio.locator('.pa-title')).toHaveText('after the storm (demo)');
	await expect(singleAudio.locator('.pa-time')).toContainText('4:18');
	await expect(audioSource).toHaveAttribute('src', /^data:audio\/wav/);
	expect(await audioSource.getAttribute('controls')).toBeNull();
	await expect(audioWaveform).toHaveAttribute('aria-valuenow', '28');
	await audioSource.evaluate((node) => {
		const media = node as HTMLMediaElement;
		Object.defineProperty(media, 'duration', { configurable: true, get: () => 258 });
		Object.defineProperty(media, 'currentTime', { configurable: true, writable: true, value: 0 });
		Object.defineProperty(media, 'play', {
			configurable: true,
			value: () => {
				media.dispatchEvent(new Event('play'));
				return Promise.resolve();
			}
		});
		media.dispatchEvent(new Event('loadedmetadata'));
	});
	await expect(audioWaveform).toHaveAttribute('aria-valuenow', '28');
	const startTime = await audioSource.evaluate((node) => (node as HTMLMediaElement).currentTime);
	expect(startTime).toBeGreaterThan(70);
	expect(startTime).toBeLessThan(75);

	await singleAudio.locator('.pa-cover').click();
	await expect(singleAudio.locator('.pa-cover')).toHaveAttribute('aria-label', 'Pause');
	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical poll attachment specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const attachments = page.locator('#attachments');
	await expect(attachments.locator('.ds-sub-h').filter({ hasText: /^Polls$/ })).toBeVisible();
	await expect(attachments).toContainText('never mixed in');
	await expect(attachments).toContainText('Your vote gets a "You" chip');
	await expect(attachments).toContainText('winning row gets the strongest accent fill');
	await expect(attachments.getByText('Voting · single choice')).toBeVisible();
	await expect(attachments.getByText('Voting · multiple choices')).toBeVisible();
	await expect(attachments.getByText('Results · with vote')).toBeVisible();
	await expect(attachments.locator('.ds-spec-label').filter({ hasText: /^Ended$/ })).toBeVisible();

	const single = attachments.locator('.ds-spec').filter({ hasText: 'Voting · single choice' });
	await expect(single.locator('.post-poll-vote-row')).toHaveCount(3);
	await expect(single.locator('.post-poll-radio')).toHaveCount(3);
	await expect(single.getByRole('button', { name: 'Vote' })).toBeDisabled();
	await expect(single.getByRole('radio', { name: 'warm cassette' })).toBeDisabled();
	await expect(single.getByText('Voting is unavailable in this view')).toBeVisible();
	await single.getByRole('button', { name: 'View results ->' }).click();
	await expect(single.locator('.post-poll-row')).toHaveCount(3);
	await single.getByRole('button', { name: 'Back to voting' }).click();
	await expect(single.getByRole('radio', { name: 'warm cassette' })).not.toBeChecked();

	const multi = attachments.locator('.ds-spec').filter({ hasText: 'Voting · multiple choices' });
	await expect(multi.locator('.post-poll-check')).toHaveCount(3);
	await expect(multi.getByRole('checkbox', { name: 'CW redesign' })).toBeDisabled();
	await expect(multi.getByRole('checkbox', { name: 'Polls' })).toBeDisabled();
	await expect(multi.getByRole('button', { name: 'Vote' })).toBeDisabled();

	const results = attachments.locator('.ds-spec').filter({ hasText: 'Results · with vote' });
	await expect(results.locator('.post-poll-row')).toHaveCount(3);
	await expect(results.locator('.post-poll-row.winner')).toContainText('spinning vinyl');
	await expect(results.locator('.post-poll-row.me')).toContainText('spinning vinyl');
	await expect(results.locator('.post-poll-you')).toContainText('You');
	await expect(results.locator('.post-poll-meta')).toContainText('394 votes');
	await expect(results.locator('.post-poll-meta')).toContainText('you voted');

	const ended = attachments.locator('.ds-spec').filter({ hasText: 'Ended' });
	await expect(ended.locator('.post-poll-pill')).toContainText('Ended 2d ago');
	await expect(ended.locator('.post-poll-row.winner')).toContainText('spinning vinyl');
	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical reply addressee chip specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const posts = page.locator('#posts');
	await expect(posts.getByText('Body, mentions & reply addressees')).toBeVisible();
	await expect(posts.getByText('Reply · parent only')).toBeVisible();
	await expect(posts.getByText('Reply + cc-list')).toBeVisible();
	await expect(posts.getByText('Long cc-chain')).toBeVisible();
	await expect(posts).toContainText('ghost chip prefixed with a ↪ glyph');
	await expect(posts).toContainText('chip fill matches the cc chips');

	const parentOnly = posts.locator('.ds-spec').filter({ hasText: 'Reply · parent only' });
	const parentChip = parentOnly.locator('.post-pinged-chip-parent');
	await expect(parentOnly.locator('.post-pinged-l')).toHaveText('Replying to');
	await expect(parentChip).toContainText('@gridwave');
	await expect(parentChip.locator('svg')).toBeVisible();
	await expect(parentOnly.locator('.ds-spec-note')).toHaveText("addressees=[parent] · ghost chip + ↪ glyph · no 'also'");
	await expect(parentChip).toHaveCSS('font-weight', '500');
	await expect(parentChip).not.toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect(parentChip).not.toHaveCSS('background-color', 'rgb(164, 139, 217)');
	await expect(parentOnly.locator('.post-pinged-also')).toHaveCount(0);

	const ccList = posts.locator('.ds-spec').filter({ hasText: 'Reply + cc-list' });
	const ccParentChip = ccList.locator('.post-pinged-chip-parent');
	const firstCcChip = ccList.locator('.post-pinged-chip').first();
	const firstCcStyles = await firstCcChip.evaluate((element) => {
		const styles = getComputedStyle(element);
		return {
			backgroundColor: styles.backgroundColor,
			color: styles.color
		};
	});
	await expect(ccList.locator('.post-pinged-chip-parent .post-pinged-handle')).toHaveText('@dtluna');
	await expect(ccParentChip).toHaveAttribute('title', '@dtluna@retro.social');
	await expect(ccParentChip).toHaveCSS('background-color', firstCcStyles.backgroundColor);
	await expect(ccParentChip).toHaveCSS('color', firstCcStyles.color);
	await expect(ccList.locator('.post-pinged-also')).toContainText('also');
	await expect(ccList.locator('.post-pinged-chip')).toHaveCount(2);
	await expect(firstCcChip).toHaveText('@feld');
	await expect(firstCcChip).toHaveAttribute('title', '@feld@queer.party');
	await expect(ccList.locator('.post-pinged-list')).not.toContainText('@dtluna@retro.social');
	await expect(ccList.locator('.post-pinged-list')).not.toContainText('@feld@queer.party');
	await expect(ccList.locator('.ds-spec-note')).toHaveText('addressees=[parent, …cc] · all ghost chips · parent prefixed with ↪');

	const longChain = posts.locator('.ds-spec').filter({ hasText: 'Long cc-chain' });
	await expect(longChain.locator('.ds-spec-note')).toHaveText('parent stays prominent · cc-list wraps to second row');

	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical boosted post specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const posts = page.locator('#posts');
	await expect(posts.getByText('Boosts')).toBeVisible();
	await expect(posts).toContainText('A 4px accent-green left edge runs the full height of the boost');
	await expect(posts).toContainText('Long names get the full row width');
	await expect(posts.getByText('Boosted · text post')).toBeVisible();
	await expect(posts.getByText('Boosted · with photo')).toBeVisible();

	const boostedText = posts.locator('.ds-spec').filter({ hasText: 'Boosted · text post' });
	const boostedTextWrapper = boostedText.locator('.post-boost');
	const boostedTextAttr = boostedTextWrapper.locator('> .post-boost-attr');
	await expect(boostedTextWrapper).toBeVisible();
	await expect(boostedTextWrapper).toHaveCSS('border-left-width', '4px');
	await expect(boostedTextWrapper.locator('> .post-boost-rail')).toHaveCount(0);
	await expect(boostedTextAttr).toBeVisible();
	await expect(boostedTextAttr.locator('.post-boost-tag')).toContainText('boost');
	await expect(boostedTextAttr.locator('.post-boost-av')).toBeVisible();
	await expect(boostedTextAttr.locator('.post-boost-name')).toContainText('FiestaBun');
	await expect(boostedTextAttr.locator('.post-boost-handle')).toContainText('@FiestaBun@decayable.ink');
	await expect(boostedTextAttr.locator('.post-boost-time')).toContainText('35m');
	const extraNameWidth = await boostedTextAttr.locator('.post-boost-name').evaluate((element) => element.clientWidth - element.scrollWidth);
	expect(extraNameWidth).toBeLessThan(8);
	await expect(boostedText.locator('.post')).toContainText("the algorithm doesn't care about you");

	const boostedPhoto = posts.locator('.ds-spec').filter({ hasText: 'Boosted · with photo' });
	await expect(boostedPhoto.locator('.ds-spec-note')).toHaveText('left edge runs full height regardless of content');
	await expect(boostedPhoto.locator('.post-boost > .post-boost-attr')).toBeVisible();
	await boostedPhoto.locator('.post-photos button').click();
	const dialog = page.getByRole('dialog', { name: 'Attachment lightbox' });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator('.lightbox-photo')).toHaveAttribute('src', 'samples/falco.png');
	await dialog.getByRole('button', { name: 'Close', exact: true }).click();

	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical content warning post specimens', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const posts = page.locator('#posts');
	await expect(posts.getByText('Content warnings')).toBeVisible();
	await expect(posts).toContainText('<PostCW/> primitive wraps the hidden region');
	await expect(posts.getByText('Folded · with media')).toBeVisible();
	await expect(posts.getByText('Folded · text only')).toBeVisible();
	await expect(posts.getByText('Folded · with poll')).toBeVisible();

	const mediaCw = posts.locator('.ds-spec').filter({ hasText: 'Folded · with media' });
	await expect(mediaCw.locator('.post-cw-card')).toContainText('food, plated photos');
	await expect(mediaCw.locator('.post-cw-meta-chip')).toContainText(['2 photos', '~27 words']);
	await expect(mediaCw).not.toContainText('every restaurant photo I take');
	await expect(mediaCw.locator('.post-photos')).toHaveCount(0);
	await mediaCw.getByRole('button', { name: 'Show post' }).click();
	await expect(mediaCw.locator('.post-cw-revealed-summary')).toContainText('food, plated photos');
	await expect(mediaCw).toContainText('every restaurant photo I take');
	await expect(mediaCw.locator('.post-photos')).toBeVisible();
	await mediaCw.getByRole('button', { name: 'Hide' }).click();
	await expect(mediaCw).not.toContainText('every restaurant photo I take');

	const pollCw = posts.locator('.ds-spec').filter({ hasText: 'Folded · with poll' });
	await expect(pollCw.locator('.post-cw-meta-chip')).toContainText(['poll', '~16 words']);
	await expect(pollCw).not.toContainText('rough day');
	const textCw = posts.locator('.ds-spec').filter({ hasText: 'Folded · text only' });
	await expect(textCw.locator('.ds-spec-note')).toHaveText('no attachments · no chips row');
	await setViewport(page, 'mobile');
	await expectNoHorizontalOverflow(page);
});

test('renders the canonical thread specimen with targeted inline reply composers', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const thread = page.locator('#thread');
	await expect(thread).toContainText('Pressing Reply on any post unfolds an inline composer beneath it');
	await expect(thread.getByText('Full thread')).toBeVisible();
	await expect(thread.locator('.ds-spec-note')).toHaveText('AncestorPost → FocusedPost → ReplyPost');
	await expect(thread.getByText('gridwave', { exact: true })).toBeVisible();
	await expect(thread.getByText('nyan.binary', { exact: true })).toBeVisible();
	await expect(thread.getByText('2 replies')).toBeVisible();
	await expect(thread.locator('.thread-reply-composer')).toHaveCount(0);
	await expect(thread.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	const ancestorPost = thread.locator('.post-ancestor').filter({ hasText: 'gridwave' }).first();
	const ancestorReplyButton = ancestorPost.getByRole('button', { name: 'Reply 18' });
	await expect(ancestorReplyButton).toHaveAttribute('aria-expanded', 'false');
	await ancestorReplyButton.click();
	const ancestorComposer = thread.getByRole('form', { name: 'Inline reply to gridwave' });
	await expect(ancestorComposer).toBeVisible();
	await expect(ancestorReplyButton).toHaveAttribute('aria-expanded', 'true');
	await expect(ancestorReplyButton).toHaveAttribute('aria-controls', await ancestorComposer.getAttribute('id') ?? 'missing-inline-reply-id');
	await ancestorComposer.getByRole('button', { name: 'Cancel' }).click();

	const focusedPost = thread.locator('.focused-post');
	const focusedReplyButton = focusedPost.getByRole('button', { name: 'Reply 2' });
	await expect(focusedReplyButton).toHaveAttribute('aria-expanded', 'false');
	await focusedReplyButton.click();
	const focusedComposer = thread.getByRole('form', { name: 'Inline reply to emi' });
	await expect(focusedComposer).toBeVisible();
	await expect(focusedReplyButton).toHaveAttribute('aria-expanded', 'true');
	await expect(focusedReplyButton).toHaveAttribute('aria-controls', await focusedComposer.getAttribute('id') ?? 'missing-inline-reply-id');
	await focusedComposer.getByRole('button', { name: 'Cancel' }).click();

	const nyanReply = thread.locator('.post-reply').filter({ hasText: 'this is the energy i needed today' }).first();
	await nyanReply.getByRole('button', { name: 'Reply 2' }).click();
	const nyanComposer = thread.getByRole('form', { name: 'Inline reply to nyan.binary' });
	await expect(nyanComposer).toBeVisible();
	await expect(nyanComposer).toContainText('Replying to');
	await expect(nyanComposer).toContainText('nyan.binary');
	await expect(nyanComposer.getByRole('button', { name: 'Reply', exact: true })).toBeDisabled();
	await nyanComposer.getByRole('textbox', { name: 'Reply text' }).fill('soft web yes');
	await expect(nyanComposer.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
	await nyanReply.getByRole('button', { name: 'Reply 2' }).click();
	await expect(thread.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	await nyanReply.getByRole('button', { name: 'Reply 2' }).click();
	const reopenedNyanComposer = thread.getByRole('form', { name: 'Inline reply to nyan.binary' });
	await expect(reopenedNyanComposer.getByRole('textbox', { name: 'Reply text' })).toBeEmpty();
	await reopenedNyanComposer.getByRole('textbox', { name: 'Reply text' }).fill('soft web yes');

	const softReply = thread.locator('.post-reply').filter({ hasText: 'touched grass too' }).first();
	await softReply.getByRole('button', { name: 'Reply 0' }).click();
	await expect(thread.getByRole('form', { name: /Inline reply/ })).toHaveCount(1);
	const softComposer = thread.getByRole('form', { name: 'Inline reply to soft.hertz' });
	await expect(softComposer).toBeVisible();
	await expect(softComposer.getByRole('textbox', { name: 'Reply text' })).toBeEmpty();

	await softComposer.getByRole('button', { name: 'Cancel' }).click();
	await expect(thread.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	await softReply.getByRole('button', { name: 'Reply 0' }).click();
	await softComposer.getByRole('textbox', { name: 'Reply text' }).fill('submit closes this composer');
	await softComposer.getByRole('button', { name: 'Reply', exact: true }).click();
	await expect(thread.getByRole('form', { name: /Inline reply/ })).toHaveCount(0);

	await setViewport(page, 'mobile');
	await softReply.getByRole('button', { name: 'Reply 0' }).click();
	await expect(thread.getByRole('form', { name: 'Inline reply to soft.hertz' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('renders the canonical profile specimen with tabs and side rail', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const profile = page.locator('#profile');
	await expect(profile).toContainText('ProfileView → ProfileSideRail');
	await expect(profile.getByRole('heading', { name: 'soft.hertz ✦' })).toBeVisible();
	await expect(profile).toContainText('@soft.hertz@kolektiva.social');
	await expect(profile).toContainText('field recordings + slow web');
	await expect(profile).toContainText('Mutuals');
	await expect(profile).toContainText('remote');
	await expect(profile).toContainText('Numbers');
	await expect(profile).toContainText('2,148');
	await expect(profile).toContainText('Details');
	await expect(profile).toContainText('softhertz.land');
	await expect(profile).toContainText("the algorithm doesn't care about you");

	await profile.getByRole('tab', { name: /Posts & Replies/ }).click();
	await expect(profile).toContainText('reply from the margins');
	await profile.getByRole('tab', { name: /Media/ }).click();
	await expect(profile.locator('.pp-media-grid')).toBeVisible();
	await expect(profile).toContainText('AUDIO');

	await setViewport(page, 'mobile');
	await expect(profile).toContainText('Numbers');
	await expectNoHorizontalOverflow(page);
});

test('renders canonical notification rows and popover controls', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const notifications = page.locator('#notifications');
	await expect(notifications.getByText('Mention · unread')).toBeVisible();
	await expect(notifications.getByText('Favorite · grouped')).toBeVisible();
	await expect(notifications.getByText('Follow request')).toBeVisible();
	await expect(notifications.getByText('orbit mentioned you').first()).toBeVisible();
	await expect(notifications.getByText('kestrel, mossy and 2 others favorited your post').first()).toBeVisible();
	await expect(notifications.getByRole('button', { name: 'Accept' }).first()).toBeVisible();
	await expect(notifications.getByRole('button', { name: 'Decline' }).first()).toBeVisible();
	await expect(notifications.getByText('NotifsPopover')).toBeVisible();
	await expect(notifications.locator('.notif-pop')).toContainText('3 new');

	await notifications.getByRole('button', { name: 'Boosts' }).click();
	await expect(notifications.locator('.notif-pop-body')).toContainText('lumen, mossy and 1 other boosted your post');

	await notifications.getByRole('button', { name: 'Mark all read' }).click();
	await expect(notifications.locator('.notif-pop-count')).toBeHidden();
});

test('renders canonical radio specimens and controls', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const radio = page.locator('#radio');
	await expect(radio.getByText('NowPlayingLine')).toBeVisible();
	await expect(radio.locator('.ds-nps-stack').getByText('pacific hour')).toHaveCount(2);
	await expect(radio.locator('.ds-nps-stack').getByText('paused')).toHaveCount(2);
	await expect(radio.getByText('Compact bar (collapsed)')).toBeVisible();
	await expect(radio.locator('.radio').first()).toContainText('PN.fm · Retrowave');
	await expect(radio.getByText('Radio · Now playing tab')).toBeVisible();
	await expect(radio.getByText('Album · Outer Drive')).toBeVisible();
	await expect(radio.getByRole('button', { name: 'coastline 1986' })).toBeVisible();
	await expect(radio.getByText('Radio · Albums tab')).toBeVisible();
	await expect(radio.getByRole('button', { name: /Modem Hymns/ })).toBeVisible();
	await expect(radio.getByRole('button', { name: /Garden Hours/ })).toBeVisible();

	const interactive = radio.locator('.radio').nth(1);
	await interactive.getByRole('button', { name: 'Play', exact: true }).first().click();
	await expect(interactive.getByRole('button', { name: 'Pause', exact: true }).first()).toBeVisible();
});

test('renders canonical oekaki anatomy and launcher', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const oekaki = page.locator('#oekaki');
	const anatomyList = oekaki.locator('.ds-anatomy-list');
	await expect(anatomyList.getByText('Tool rail', { exact: true })).toBeVisible();
	await expect(anatomyList.getByText('Canvas', { exact: true })).toBeVisible();
	await expect(anatomyList.getByText('Side panel', { exact: true })).toBeVisible();
	await expect(anatomyList.getByText('Footer', { exact: true })).toBeVisible();
	await expect(oekaki.getByTitle('Brush').first()).toBeVisible();
	await expect(oekaki.getByTitle('Text').first()).toBeVisible();

	await oekaki.getByRole('button', { name: 'Launch fullscreen →' }).click();
	const modal = page.getByRole('dialog', { name: 'oekaki' });
	await expect(modal).toBeVisible();
	await expect(modal).toContainText('~/draft/untitled.png');
	await modal.getByTitle('Pen').click();
	await expect(modal).toContainText('PNG · 800×600 · pen');
	await page.keyboard.press('Escape');
	await expect(modal).toBeHidden();
});

test('keeps the design system usable on mobile', async ({ page }) => {
	await setViewport(page, 'mobile');
	await page.goto('/design-system');

	await expect(page.getByRole('heading', { name: 'Foundations' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Simoun' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Thread' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Radio · PN.fm' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Oekaki' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('renders canonical emoji reaction row specimen', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const specimen = page.locator('#posts .ds-spec').filter({ hasText: 'Reaction row · letterpress stamps' });
	const reactions = specimen.getByTestId('post-reactions');
	await expect(reactions).toBeVisible();

	const heart = reactions.getByRole('button', { name: /❤️ · 24 reactions · you reacted/ });
	await expect(heart).toHaveAttribute('aria-pressed', 'true');
	await expect(reactions.getByText('24', { exact: true })).toBeVisible();
	await expect(reactions.locator('img[alt=":pleromasummer:"]')).toBeVisible();
	await expect(reactions.locator('img[alt=":blobcat:"]')).toBeVisible();
	await expect(reactions.getByRole('button', { name: 'Add reaction' })).toBeDisabled();
	await expect(reactions.getByText('add', { exact: true })).toBeVisible();

	await expectNoHorizontalOverflow(page);
});

test('renders media treatment specimens with halftone enhancement', async ({ page }) => {
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const treatments = page.getByTestId('media-treatments');
	await treatments.scrollIntoViewIfNeeded();
	await expect(treatments.getByText('Original', { exact: true })).toBeVisible();
	await expect(treatments.getByTestId('treatment-duotone')).toBeVisible();

	const halftone = treatments.locator('.halftone-media');
	await expect(halftone).toHaveAttribute('data-halftone-state', 'ready');
	await expect(halftone.locator('img.halftone-original')).toHaveAttribute('alt', 'cat on a river bank');
	await expect(halftone.locator('canvas.halftone-canvas.ready')).toBeVisible();
});

test('halftone media falls back to the original image without WebGL', async ({ page }) => {
	await page.addInitScript(() => {
		const original = HTMLCanvasElement.prototype.getContext;
		Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
			configurable: true,
			value: function (this: HTMLCanvasElement, contextId: string, ...args: unknown[]) {
				if (contextId === 'webgl2' || contextId === 'webgl') return null;
				return original.call(this, contextId as never, ...(args as never[]));
			}
		});
	});
	await setViewport(page, 'desktop');
	await page.goto('/design-system');

	const halftone = page.getByTestId('media-treatments').locator('.halftone-media');
	await halftone.scrollIntoViewIfNeeded();
	await expect(halftone).toHaveAttribute('data-halftone-state', 'fallback');
	await expect(halftone.locator('img.halftone-original')).toBeVisible();
	await expect(halftone.locator('canvas.halftone-canvas.ready')).toHaveCount(0);
});
