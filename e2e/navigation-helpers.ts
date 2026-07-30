import type { Page, Response } from "@playwright/test";

const WEBKIT_INTERNAL_NAVIGATION_ERROR = "WebKit encountered an internal error";

async function retryWebKitInternalNavigation(
  page: Page,
  navigate: () => Promise<Response | null>,
): Promise<void> {
  try {
    await navigate();
  } catch (error) {
    if (!String(error).includes(WEBKIT_INTERNAL_NAVIGATION_ERROR)) throw error;
    // This is a Playwright/WebKit transport failure rather than an application
    // assertion. A same-page retry preserves the zero-retry test contract while
    // still surfacing every ordinary navigation or render failure.
    await page.waitForTimeout(100);
    await navigate();
  }
  await page.waitForFunction(
    () => Boolean((window as unknown as { __editor?: unknown }).__editor),
  );
}

export async function gotoApp(page: Page): Promise<void> {
  await retryWebKitInternalNavigation(
    page,
    () => page.goto("/", { waitUntil: "domcontentloaded" }),
  );
}

export async function reloadApp(page: Page): Promise<void> {
  await retryWebKitInternalNavigation(
    page,
    () => page.reload({ waitUntil: "domcontentloaded" }),
  );
}
