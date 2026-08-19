/**
 * Playwright 設定。
 * ブラウザ × 端末の project は config/devices.yml から自動生成する。
 * Firefox / WebKit を追加する場合は config/devices.yml の enabled を true にするだけでよい。
 */
import path from 'node:path';
import { defineConfig, devices as playwrightDevices } from '@playwright/test';
import { isCi, loadConfig, PROJECT_ROOT } from './utils/config';
import type { BrowserId, DeviceConfig } from './utils/types';

const config = loadConfig();
const { runtime, environment } = config;

const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

/** ブラウザごとの基本設定 */
function browserDefaults(browserId: BrowserId) {
  switch (browserId) {
    case 'firefox':
      return playwrightDevices['Desktop Firefox'];
    case 'webkit':
      return playwrightDevices['Desktop Safari'];
    default:
      return playwrightDevices['Desktop Chrome'];
  }
}

/**
 * 端末設定をブラウザに適用する。
 * isMobile / hasTouch は Firefox が非対応なので、その場合は viewport と UA のみ適用する。
 */
function deviceUse(browserId: BrowserId, device: DeviceConfig) {
  const supportsMobileEmulation = browserId !== 'firefox';
  return {
    viewport: device.viewport,
    deviceScaleFactor: device.deviceScaleFactor ?? 1,
    ...(supportsMobileEmulation
      ? { isMobile: Boolean(device.isMobile), hasTouch: Boolean(device.hasTouch) }
      : {}),
    ...(device.userAgent ? { userAgent: device.userAgent } : {}),
  };
}

const projects = config.devices.browsers
  .filter((browser) => browser.enabled)
  .flatMap((browser) =>
    config.devices.devices.map((device) => ({
      name: `${browser.id}-${device.id}`,
      // 端末・ブラウザ情報はテスト側から testInfo.project.metadata で参照する
      metadata: {
        browserId: browser.id,
        deviceId: device.id,
        deviceLabel: device.label,
      },
      use: {
        ...browserDefaults(browser.id),
        ...deviceUse(browser.id, device),
      },
    })),
  );

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(REPORT_DIR, 'test-results'),
  // 基準画像は screenshots/baseline/<環境>/<project> 配下に保存する。
  // 環境ごとに分けることで、local の基準画像がステージング/本番の比較に使われることを防ぐ。
  snapshotPathTemplate: `screenshots/baseline/${config.environmentName}/{projectName}/{testFilePath}/{arg}{ext}`,
  fullyParallel: true,
  forbidOnly: isCi(),
  retries: isCi() ? runtime.retriesCi : runtime.retries,
  workers: isCi() ? runtime.workersCi : runtime.workers,
  timeout: runtime.timeouts.test,
  expect: {
    timeout: runtime.timeouts.expect,
    toHaveScreenshot: {
      threshold: config.visual.compare.threshold,
      ...(config.visual.compare.maxDiffPixelRatio !== null
        ? { maxDiffPixelRatio: config.visual.compare.maxDiffPixelRatio }
        : {}),
      ...(config.visual.compare.maxDiffPixels !== null
        ? { maxDiffPixels: config.visual.compare.maxDiffPixels }
        : {}),
      animations: config.visual.compare.animations,
      caret: config.visual.compare.caret,
    },
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(REPORT_DIR, 'playwright-report'), open: 'never' }],
    ['./reporters/qa-html-reporter.ts'],
  ],
  use: {
    baseURL: environment.baseUrl,
    navigationTimeout: runtime.timeouts.navigation,
    actionTimeout: runtime.timeouts.action,
    trace: isCi() ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: false,
    ...(environment.httpCredentials ? { httpCredentials: environment.httpCredentials } : {}),
    // ローカル Chromium を明示指定したい場合のみ使用する
    ...(process.env.QA_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.QA_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  projects,
  // local 環境ではモックサイト (LP ドメイン + 申込ドメイン) を自動起動する
  ...(environment.startLocalServer
    ? {
        webServer: [
          {
            command: 'node fixtures/mock-site/server.mjs',
            url: environment.baseUrl,
            reuseExistingServer: !isCi(),
            timeout: 30000,
            stdout: 'ignore',
            stderr: 'pipe',
            env: {
              MOCK_SITE_PORT: String(new URL(environment.baseUrl).port || 4173),
              MOCK_APPLICATION_ORIGIN: environment.applicationBaseUrl,
            },
          },
          {
            command: 'node fixtures/mock-site/application-server.mjs',
            url: `${environment.applicationBaseUrl}/entry/`,
            reuseExistingServer: !isCi(),
            timeout: 30000,
            stdout: 'ignore',
            stderr: 'pipe',
            env: {
              MOCK_APPLICATION_PORT: String(new URL(environment.applicationBaseUrl).port || 4174),
            },
          },
        ],
      }
    : {}),
});
