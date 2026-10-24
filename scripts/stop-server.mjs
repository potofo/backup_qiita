/**
 * npm stop: 起動中のサーバを停止する
 * - サーバ起動時に書き出される .server.pid を読み、該当プロセスを終了する
 * - Windowsでは process.kill がプロセスを強制終了する(シグナルハンドラは実行されない)ため、
 *   PIDファイルの後始末はこのスクリプト側で行う
 */
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const pidPath = resolve(process.cwd(), ".server.pid");

const removePidFile = () => {
  try {
    unlinkSync(pidPath);
  } catch {
    // 既に無ければ何もしない
  }
};

if (!existsSync(pidPath)) {
  console.log("PIDファイル(.server.pid)がありません。サーバは起動していないようです。");
  process.exit(0);
}

const pid = Number(readFileSync(pidPath, "utf8").trim());
if (!Number.isInteger(pid) || pid <= 0) {
  console.error(`PIDファイルの内容が不正です: ${pidPath}`);
  removePidFile();
  process.exit(1);
}

try {
  process.kill(pid);
  console.log(`サーバ(PID ${pid})を停止しました。`);
} catch (cause) {
  if (cause?.code === "ESRCH") {
    console.log(`サーバ(PID ${pid})は既に停止しています。`);
  } else {
    console.error(`サーバ(PID ${pid})の停止に失敗しました:`, cause);
    process.exit(1);
  }
}
removePidFile();
