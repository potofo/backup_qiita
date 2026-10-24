/**
 * ディレクトリの再帰削除(image-upload-automation 5.1, 5.3)
 * - この開発環境では fs.rmSync(..., { force: true }) が黙って失敗するため、unlinkSync / rmdirSync で1件ずつ消す(steering tech.md)
 * - 削除できなかったパスを返し、呼び出し元でログに残せるようにする(例外は投げない)
 */
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export function removeDirRecursive(dir: string): string[] {
  const failed: string[] = [];
  if (!existsSync(dir)) return failed;
  const walk = (path: string): void => {
    let isDir: boolean;
    try {
      // シンボリックリンクはたどらずリンク自体を消す
      isDir = lstatSync(path).isDirectory();
    } catch {
      return;
    }
    if (isDir) {
      for (const name of readdirSync(path)) walk(join(path, name));
      try {
        rmdirSync(path);
      } catch {
        failed.push(path);
      }
    } else {
      try {
        unlinkSync(path);
      } catch {
        failed.push(path);
      }
    }
  };
  walk(dir);
  return failed;
}
