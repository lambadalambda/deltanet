import { expect, test, type Page } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectNoHorizontalOverflow, setViewport } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page) => {
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('headwater.session', JSON.stringify(storedSession));
	}, session);
};

test('real explore route renders hero, tags, topics, communities, and discover feed', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/explore');

	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();
	const search = page.getByRole('searchbox', { name: 'Search topics, people, and posts' });
	await expect(search).toBeVisible();
	await search.fill('vaporwave');
	await expect(search).toHaveValue('vaporwave');
	await expect(page.getByRole('button', { name: '#fediverse' })).toBeVisible();
	await expect(page.getByTestId('explore-topic-card')).toHaveCount(3);
	await expect(page.getByTestId('explore-community-card')).toHaveCount(3);
	await expect(page.getByTestId('explore-feed')).toContainText('Popular across friendly instances');
	await expect(page.getByTestId('explore-artwork')).toBeVisible();
	await expectNoHorizontalOverflow(page);
});

test('real explore route switches discover feed tabs', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/explore');

	const feedTabs = page.getByRole('tablist', { name: 'Discover feed' });
	await expect(feedTabs.getByRole('tab', { name: 'Popular' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('explore-feed')).toContainText('Popular across friendly instances');

	await feedTabs.getByRole('tab', { name: 'New' }).click();
	await expect(feedTabs.getByRole('tab', { name: 'New' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('explore-feed')).toContainText('Fresh instance dispatches');

	await feedTabs.getByRole('tab', { name: 'Active' }).click();
	await expect(feedTabs.getByRole('tab', { name: 'Active' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByTestId('explore-feed')).toContainText('Most replied threads');
});

test('real explore route community join buttons retain local joined state', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'desktop');
	await page.goto('/app/explore');

	const community = page.getByTestId('explore-community-card').filter({ hasText: 'Federated CSS Garden' });
	const join = community.getByRole('button', { name: 'Join Federated CSS Garden' });

	await expect(join).toHaveAttribute('aria-pressed', 'false');
	await join.click();
	await expect(community.getByRole('button', { name: 'Joined Federated CSS Garden' })).toHaveAttribute('aria-pressed', 'true');
});

test('real explore route stacks cleanly on mobile', async ({ page }) => {
	await authenticate(page);
	await setViewport(page, 'mobile');
	await page.goto('/app/explore');

	await expect(page.getByRole('heading', { name: 'Explore the network' })).toBeVisible();
	await expect(page.getByTestId('explore-topic-card').first()).toBeVisible();
	await expect(page.getByTestId('explore-community-card').first()).toBeVisible();
	await expect(page.getByRole('searchbox', { name: 'Search topics, people, and posts' })).toBeVisible();
	await expectNoHorizontalOverflow(page);
});
