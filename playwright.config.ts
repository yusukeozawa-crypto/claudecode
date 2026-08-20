/**
 * Playwright 設定。
 * ブラウザ × 端末の project は config/devices.yml から自動生成する。
 * Firefox / WebKit を追加する場合は config/devices.yml の enabled を true にするだけでよい。
 */
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { isCi, loadConfig, PROJECT_ROOT } from './utils/config';
import { buildProjects } from './utils/projects';

const config = loadConfig();
const { runtime, environment } = config;

const REPORT_DIR = path.join(PROJECT_ROOT, 'reports');

// project (ブラウザ × 端末) の生成は utils/projects.ts に分離してある。
// Firefox / WebKit は config/devices.yml の enabled を true にするだけで対象に加わる。
const projects = buildProjects(config.devices, {
  chromiumExecutablePath: process.env.QA_CHROMIUM_EXECUTABLE,
});

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
    // トレースには通信内容 (Authorization ヘッダー・一時トークン・Cookie・
    // リクエストボディ) がそのまま含まれ、マスキングの対象外である。
    // 実サイトを対象にする実行では QA_TRACE=off を指定して取得しない
    // (CI の Artifact は repo の読み取り権限があれば誰でも取得できる)。
    trace: (process.env.QA_TRACE as 'off' | 'on' | 'retain-on-failure' | 'on-first-retry' | undefined)
      ?? (isCi() ? runtime.traceCi : runtime.trace),
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: false,
    ...(environment.httpCredentials ? { httpCredentials: environment.httpCredentials } : {}),
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
