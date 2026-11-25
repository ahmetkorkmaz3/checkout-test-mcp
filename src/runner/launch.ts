import type { Browser, BrowserType, LaunchOptions } from 'playwright';
import type { BrowserInfo } from '../schemas/run.js';

export type BrowserChoice = 'auto' | 'chromium' | 'chrome';

const INSTALL_CHROMIUM = 'Run "npx checkout-test-mcp init" or "npx playwright install chromium".';
const INSTALL_CHROME = 'Install Google Chrome.';

/** Playwright words a missing Chromium download or a missing Chrome install in different ways. */
function isMissingBrowser(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|Chromium distribution '[^']*' is not found/.test(msg);
}

/** One line only: the run failure uses the first line of the message. */
function noBrowser(detail: string): Error {
  return new Error(`No browser found. ${detail}`);
}

/**
 * Starts the browser for a run or an inspection. The caller passes the proxy and the args of the host
 * guard in `options`. Both launches use them unchanged. In "auto" mode only a missing executable
 * switches to Chrome: another launch error must not hide behind a second browser.
 */
export async function launchBrowser(
  choice: BrowserChoice,
  options: LaunchOptions,
  launcher: Pick<BrowserType, 'launch'>,
): Promise<{ browser: Browser; info: BrowserInfo }> {
  const start = async (name: BrowserInfo['name']) => {
    const browser = await launcher.launch(name === 'chrome' ? { ...options, channel: 'chrome' } : options);
    return { browser, info: { name, version: browser.version() } };
  };

  if (choice === 'chrome') {
    try {
      return await start('chrome');
    } catch (err) {
      if (!isMissingBrowser(err)) throw err;
      throw noBrowser(`Google Chrome is not installed. ${INSTALL_CHROME}`);
    }
  }
  try {
    return await start('chromium');
  } catch (err) {
    if (!isMissingBrowser(err)) throw err;
    if (choice === 'chromium') {
      throw noBrowser(`Playwright Chromium is not installed. ${INSTALL_CHROMIUM}`);
    }
  }
  try {
    return await start('chrome');
  } catch (err) {
    if (!isMissingBrowser(err)) throw err;
    throw noBrowser(
      `Playwright Chromium and Google Chrome are not installed. ${INSTALL_CHROMIUM} Or: ${INSTALL_CHROME}`,
    );
  }
}
