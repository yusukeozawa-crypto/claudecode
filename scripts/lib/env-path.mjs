/**
 * 子プロセスの PATH に node_modules/.bin を追加する。
 *
 * Windows では環境変数の実際のキー名が `Path` のため、
 * `{ ...process.env, PATH: ... }` のように書くと `Path` と `PATH` の
 * 2 つのキーが並び、どちらが使われるかは不定になる。
 * `PATH` 側が採用されると元の PATH が失われ、
 * npm の shim が呼ぶ `node` が見つからなくなる
 * (`'"node"' は、内部コマンドまたは外部コマンド ... として認識されていません`)。
 *
 * そのため既存のキーを大小文字を無視して探し、そのキーを更新する。
 */
import path from 'node:path';

export function withBinPath(binDir, baseEnv = process.env) {
  const env = { ...baseEnv };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${binDir}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}
