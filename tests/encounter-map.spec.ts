import { test, expect, Page } from '@playwright/test';
import { checkA11y } from './utils/axe-helper';
import { getSeedState } from './seed-data';

const SUITE_ID = 'encounter-map-suite';
const baseSeed = getSeedState(SUITE_ID);

const mapSeed = {
  ...baseSeed,
  chapters: [
    {
      id: `${SUITE_ID}-chap-1`,
      title: 'Chapter 1: The Sinking Shore',
      content: 'Trouble begins at the shore. @Encounter[encounter-map-1]{Map 5.1: Palma Flora}',
      order: 0
    }
  ],
  encounters: [
    {
      id: 'encounter-map-1',
      name: 'Map 5.1: Palma Flora',
      chapterIds: [`${SUITE_ID}-chap-1`],
      dmMapUrl: '/maps/5.1-palma-flora.png',
      playerMapUrl: '/maps/5.1-palma-flora-player.png',
      mapSize: { width: 20, height: 20 },
      units: [
        {
          instanceId: `${SUITE_ID}-unit-1`,
          monsterId: '17003',
          name: 'sahuagin',
          maxHp: 22,
          currentHp: 22,
          hpDice: '4d8 + 4',
          dexMod: 0,
          initiative: 12,
          passivePerception: 10,
          isPlayer: false,
          position: { x: 2, y: 2 }
        },
        {
          instanceId: `${SUITE_ID}-player-1`,
          playerId: `${SUITE_ID}-p-1`,
          name: 'Grog',
          maxHp: 30,
          currentHp: 30,
          dexMod: 2,
          initiative: 16,
          passivePerception: 14,
          isPlayer: true,
          position: { x: 4, y: 4 }
        }
      ]
    }
  ]
};

const setupApp = async (page: Page) => {
  await page.addInitScript((id) => {
    window.localStorage.clear();
    window.localStorage.setItem('crits_active_campaign', id);
  }, SUITE_ID);
  await page.goto('/');
  await page.waitForSelector('header');
};

test.describe('Encounter Map Accessibility and Workflow Suite', () => {
  test.beforeAll(async ({ request }) => {
    const apiBase = 'http://localhost:3005/api';
    await request.delete(`${apiBase}/danger/reset`);
    const res = await request.post(`${apiBase}/campaigns`, { data: mapSeed });
    if (!res.ok()) throw new Error(`Failed to seed suite: ${res.status()}`);
  });

  test.beforeEach(async ({ page, request }) => {
    const apiBase = 'http://localhost:3005/api';
    await request.post(`${apiBase}/campaigns`, { data: mapSeed });
    await setupApp(page);
  });

  test('Chapter shows Map Available badge and encounter link in Run Mode', async ({ page }) => {
    await page.keyboard.press('Alt+m');
    await expect(page.getByRole('heading', { name: 'Run Mode' })).toBeVisible();

    // Chapter Encounters list
    const runEncounterLink = page.getByRole('link', { name: /Run Map 5\.1: Palma Flora/ });
    await expect(runEncounterLink).toBeVisible();

    // Map Available badge should be visible next to it
    const mapBadge = page.locator('text=Map Available');
    await expect(mapBadge).toBeVisible();
  });

  test('Combat Map toolbar contains Backdrop and Art controls', async ({ page, context }) => {
    await page.keyboard.press('Alt+m');
    await expect(page.getByRole('heading', { name: 'Run Mode' })).toBeVisible();

    const [encounterPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: /Run Map 5\.1: Palma Flora/ }).click()
    ]);
    await encounterPage.waitForLoadState();

    // Verify "View Map" button is not present
    await expect(encounterPage.getByRole('button', { name: /View Map/ })).not.toBeVisible();

    // Start combat
    const startBtn = encounterPage.getByRole('button', { name: 'Start Combat' });
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    await expect(startBtn).not.toBeVisible();

    // Verify Combat Map is mounted
    const combatMapHeading = encounterPage.getByRole('heading', { name: /Combat Map/ });
    await expect(combatMapHeading).toBeVisible();

    // Verify toolbar backdrop controls
    const backdropToggleBtn = encounterPage.getByRole('button', { name: /Grid Backdrop/ });
    await expect(backdropToggleBtn).toBeVisible();
    await expect(backdropToggleBtn).toHaveAttribute('aria-pressed', 'true');

    // Toggle backdrop off
    await backdropToggleBtn.click();
    await expect(backdropToggleBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(backdropToggleBtn).toHaveText('Show Grid Backdrop');

    // Toggle backdrop on
    await backdropToggleBtn.click();
    await expect(backdropToggleBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(backdropToggleBtn).toHaveText('Hide Grid Backdrop');

    // Verify art view toggle (DM vs Player view)
    const artToggleBtn = encounterPage.getByRole('button', { name: /Art:/ });
    await expect(artToggleBtn).toBeVisible();
    await expect(artToggleBtn).toHaveText('Art: DM View');
    await artToggleBtn.click();
    await expect(artToggleBtn).toHaveText('Art: Player View');
    await artToggleBtn.click();
    await expect(artToggleBtn).toHaveText('Art: DM View');

    // Verify Axe accessibility check on Combat Map
    await checkA11y(encounterPage, 'Combat Map - Backdrop and Art Controls');

    await encounterPage.close();
  });

  test('Combat Map backdrop lines up with the grid cells at narrow and wide viewports', async ({ page, context }) => {
    await page.keyboard.press('Alt+m');
    await expect(page.getByRole('heading', { name: 'Run Mode' })).toBeVisible();

    const [encounterPage] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: /Run Map 5\.1: Palma Flora/ }).click()
    ]);
    await encounterPage.waitForLoadState();

    const startBtn = encounterPage.getByRole('button', { name: 'Start Combat' });
    await expect(startBtn).toBeVisible();
    await startBtn.click();
    await expect(startBtn).not.toBeVisible();

    const backdropSelector = '.combat-map-section div[aria-hidden="true"][style*="background-image"]';
    await expect(encounterPage.locator(backdropSelector)).toBeVisible();

    // One battlemap square is scaled to exactly one 42px cell, so every cell has to sit on the backdrop
    // at (column * 42, row * 42) from its top-left corner: at 1024px the board is wider than the page
    // and scrolls, at 1800px it is centred with room to spare. Before the fix the automatic table layout
    // squeezed the cells to fit the narrow page, collapsed borders and default cell padding made every
    // column and row a few pixels bigger than a square, and the centred table drifted off the backdrop.
    for (const width of [1024, 1800]) {
      await encounterPage.setViewportSize({ width, height: 900 });
      const metrics = await encounterPage.evaluate((selector) => {
        const grid = document.querySelector('table[role="grid"]')!;
        const cols = Number(grid.getAttribute('aria-colcount'));
        const rows = Number(grid.getAttribute('aria-rowcount'));
        const rect = (css: string) => document.querySelector(css)!.getBoundingClientRect();
        const backdrop = rect(selector);
        const first = rect('[data-cell="0-0"]');
        const next = rect('[data-cell="1-1"]');
        const last = rect(`[data-cell="${cols - 1}-${rows - 1}"]`);
        return {
          cols,
          rows,
          cell: { w: first.width, h: first.height },
          pitch: { x: next.left - first.left, y: next.top - first.top },
          backdrop: { w: backdrop.width, h: backdrop.height },
          firstOffset: { x: first.left - backdrop.left, y: first.top - backdrop.top },
          lastOffset: { x: last.right - backdrop.right, y: last.bottom - backdrop.bottom }
        };
      }, backdropSelector);

      expect(metrics.cell, `cell size at ${width}px`).toEqual({ w: 42, h: 42 });
      expect(metrics.pitch, `cell pitch at ${width}px`).toEqual({ x: 42, y: 42 });
      expect(metrics.backdrop, `backdrop size at ${width}px`).toEqual({ w: metrics.cols * 42, h: metrics.rows * 42 });
      expect(Math.abs(metrics.firstOffset.x), `A1 left edge at ${width}px`).toBeLessThan(0.5);
      expect(Math.abs(metrics.firstOffset.y), `A1 top edge at ${width}px`).toBeLessThan(0.5);
      expect(Math.abs(metrics.lastOffset.x), `last cell right edge at ${width}px`).toBeLessThan(0.5);
      expect(Math.abs(metrics.lastOffset.y), `last cell bottom edge at ${width}px`).toBeLessThan(0.5);
    }

    await encounterPage.close();
  });
});
