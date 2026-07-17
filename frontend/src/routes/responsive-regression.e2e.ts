import { expect, test, type Page, type Route } from '@playwright/test';
import { pleromaFixtures } from '../lib/pleroma/fixtures';
import { expectNoHorizontalOverflow, mockRightRailApis, setViewport, viewports } from '../test/playwright';

const session = {
	instanceUrl: 'https://pleroma.example',
	accessToken: 'access-token',
	tokenType: 'Bearer',
	scope: 'read write follow',
	createdAt: 1700000001000,
	account: pleromaFixtures.account
};

const authenticate = async (page: Page) => {
	await mockRightRailApis(page);
	await page.addInitScript((storedSession) => {
		window.localStorage.setItem('headwater.session', JSON.stringify(storedSession));
	}, session);
};

const mockHomeTimeline = async (page: Page) => {
	await page.route('https://pleroma.example/api/v1/timelines/home**', async (route: Route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(pleromaFixtures.timelines.home)
		});
	});
};

test.describe('responsive regression coverage', () => {
	for (const viewportName of Object.keys(viewports) as Array<keyof typeof viewports>) {
		test(`signed-out landing has no horizontal overflow at ${viewportName}`, async ({ page }) => {
			await setViewport(page, viewportName);
			await page.goto('/');

			await expect(page.getByRole('heading', { name: /A quieter corner of the social web/ })).toBeVisible();
			await expect(page.getByRole('tab', { name: 'Sign in' })).toBeVisible();
			await expectNoHorizontalOverflow(page);
		});

		test(`design system primitives have no horizontal overflow at ${viewportName}`, async ({ page }) => {
			await setViewport(page, viewportName);
			await page.goto('/design-system');

			await expect(page).toHaveTitle('Headwater · Design System');
			await expect(page.getByRole('heading', { name: 'Foundations' })).toBeVisible();
			await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
			await expectNoHorizontalOverflow(page);
		});
	}

	test('real app shell has no horizontal overflow across breakpoints', async ({ page }) => {
		await authenticate(page);
		await mockHomeTimeline(page);

		await setViewport(page, 'wide');
		await page.goto('/app/home');

		await expect(page.getByTestId('left-sidebar')).toBeVisible();
		await expect(page.getByTestId('right-rail')).toBeVisible();
		await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
		await expectNoHorizontalOverflow(page);

		await setViewport(page, 'desktop');
		await expect(page.getByTestId('left-sidebar')).toBeVisible();
		await expect(page.getByTestId('right-rail')).toBeHidden();
		await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
		await expectNoHorizontalOverflow(page);

		await setViewport(page, 'medium');
		await expect(page.getByTestId('left-sidebar')).toBeVisible();
		await expect(page.getByTestId('right-rail')).toBeHidden();
		await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
		await expectNoHorizontalOverflow(page);

		await setViewport(page, 'tablet');
		await expect(page.getByTestId('left-sidebar')).toBeHidden();
		await expect(page.getByTestId('right-rail')).toBeHidden();
		await expect(page.getByRole('form', { name: 'Composer' })).toBeVisible();
		await expect(page.getByRole('navigation', { name: 'Mobile app navigation' })).toBeVisible();
		await expectNoHorizontalOverflow(page);

		await setViewport(page, 'mobile');
		await expect(page.getByTestId('left-sidebar')).toBeHidden();
		await expect(page.getByRole('navigation', { name: 'Mobile app navigation' })).toBeVisible();

		await page.getByRole('button', { name: 'Open navigation menu' }).click();
		await expect(page.getByTestId('mobile-drawer')).toBeVisible();
		await page.getByRole('button', { name: 'Close navigation menu' }).last().click();
		await expect(page.getByTestId('mobile-drawer')).toBeHidden();

		await page.getByTestId('mobile-bottom-nav').getByRole('button', { name: 'More' }).click();
		await expect(page.getByTestId('mobile-sheet')).toBeVisible();
		await page.getByRole('button', { name: 'Close details sheet' }).click();
		await expect(page.getByTestId('mobile-sheet')).toBeHidden();
		await expectNoHorizontalOverflow(page);
	});

	test('signed-out public profile has no horizontal overflow across breakpoints', async ({ page }) => {
		await page.route('https://pleroma.social/api/v1/accounts/search**', async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([{ ...pleromaFixtures.account, acct: 'quietadmin@pleroma.social', url: 'https://pleroma.social/users/quietadmin' }])
			});
		});
		await page.route('https://pleroma.social/api/v1/accounts/account-1/statuses**', async (route: Route) => {
			const url = new URL(route.request().url());
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(url.searchParams.get('pinned') === 'true' ? [] : [pleromaFixtures.status])
			});
		});

		for (const viewportName of Object.keys(viewports) as Array<keyof typeof viewports>) {
			await setViewport(page, viewportName);
			await page.goto('/app/profiles/quietadmin@pleroma.social');
			await expect(page.getByTestId('public-profile-shell')).toBeVisible();
			await expect(page.getByTestId('profile-view')).toBeVisible();
			await expectNoHorizontalOverflow(page);
		}
	});
});
