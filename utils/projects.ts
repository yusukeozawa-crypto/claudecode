/**
 * ブラウザ × 端末から Playwright の project 定義を生成する。
 *
 * playwright.config.ts から分離してあるのは、
 * 「Firefox / WebKit を config/devices.yml で有効化するだけで対象に加わる」
 * という設計をテストで検証できるようにするため
 * (tests/self-check/detectors.spec.ts)。
 */
import { devices as playwrightDevices } from '@playwright/test';
import type { BrowserId, DeviceConfig, DevicesFile } from './types';

/** project ごとの端末・ブラウザ情報 (テストとレポートから参照する) */
export interface ProjectMetadata {
  browserId: BrowserId;
  deviceId: string;
  deviceLabel: string;
}

export interface GeneratedProject {
  name: string;
  metadata: ProjectMetadata;
  use: Record<string, unknown>;
}

/** ブラウザごとの基本設定 */
export function browserDefaults(browserId: BrowserId): Record<string, unknown> {
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
export function deviceUse(browserId: BrowserId, device: DeviceConfig): Record<string, unknown> {
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

/**
 * 有効なブラウザ × 端末の全組み合わせで project を生成する。
 * project 名は `<browserId>-<deviceId>` (例: chromium-pc, firefox-sp)。
 */
export function buildProjects(
  devicesFile: DevicesFile,
  options: { chromiumExecutablePath?: string } = {},
): GeneratedProject[] {
  return devicesFile.browsers
    .filter((browser) => browser.enabled)
    .flatMap((browser) =>
      devicesFile.devices.map((device) => ({
        name: `${browser.id}-${device.id}`,
        metadata: {
          browserId: browser.id,
          deviceId: device.id,
          deviceLabel: device.label,
        },
        use: {
          ...browserDefaults(browser.id),
          ...deviceUse(browser.id, device),
          // service worker 発のリクエストは route で遮断できないため無効化する。
          // 本番で申込完了を踏まないための安全装置を素通りさせないこと。
          serviceWorkers: 'block' as const,
          // ローカルの Chromium 実体を明示指定したい場合のみ使用する。
          // Chromium 以外の project に適用すると起動できなくなるため限定する。
          ...(browser.id === 'chromium' && options.chromiumExecutablePath
            ? { launchOptions: { executablePath: options.chromiumExecutablePath } }
            : {}),
        },
      })),
    );
}
