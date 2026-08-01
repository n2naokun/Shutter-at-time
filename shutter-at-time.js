#!/usr/bin/env node
/**
 * VRChat OSC: 指定したPC時刻にカメラのシャッターを切るスクリプト (Windows想定)
 *
 * 許容精度: 目標時刻より早く発火することはない(-0ms)。遅延は+500ms以下を目安に設計。
 *           (ビジーループでCPUを占有せず、setTimeoutポーリングのみで実現)
 *
 * 事前準備:
 *   1. Node.js をインストール (Windows用インストーラでOK)
 *   2. コマンドプロンプト/PowerShellで npm install osc
 *   3. VRChat側でOSCを有効化 (アクションメニュー → OSC → Enabled)
 *      ※VRChatとNode.jsスクリプトは同一PC(localhost)で動作させる前提
 *   4. VRChatのカメラをPhotoモードで開いておく(手動でOK。自動で開きたい場合は下記コメント参照)
 *
 * 使い方 (コマンドプロンプト / PowerShell):
 *   node shutter-at-time.js 21:30:00.000        今日のこの時刻(過ぎていれば翌日)に発火
 *   node shutter-at-time.js "2026-07-27 21:30:00.000"   日時を完全指定
 */

const osc = require("osc");

const VRCHAT_HOST = "127.0.0.1";
const VRCHAT_PORT = 9000;

// ---- 時刻文字列のパース ----
function parseTargetTime(input) {
   if (!input) {
      throw new Error(
         "時刻を指定してください。例: node shutter-at-time.js 21:30:00.000"
      );
   }

   // "YYYY-MM-DD HH:MM:SS.mmm" のようなフル日時指定
   if (/\d{4}-\d{2}-\d{2}/.test(input)) {
      const target = new Date(input.replace(" ", "T"));
      if (Number.isNaN(target.getTime())) {
         throw new Error(`日時の形式が正しくありません: ${input}`);
      }
      return target;
   }

   // "HH:MM:SS" / "HH:MM:SS.mmm" / "HH:MM:SS:mmm" 形式 → 今日の日付に適用
   // (ミリ秒の区切りは "." が正式だが ":" と打ち間違えても受け付ける)
   const match = input.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
   if (!match) {
      throw new Error(
         `時刻の形式が正しくありません: ${input}\n` +
         `正しい形式の例: 21:30:00.000 または 21:30:00`
      );
   }
   const [, hh, mm, ss, msRaw = "0"] = match;
   const ms = Number(msRaw.padEnd(3, "0").slice(0, 3));

   const now = new Date();
   const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      Number(hh),
      Number(mm),
      Number(ss),
      ms
   );

   // 既に過ぎている時刻なら翌日として扱う
   if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
   }
   return target;
}

// ---- OSCポートを開く ----
function openOscPort() {
   return new Promise((resolve, reject) => {
      const udpPort = new osc.UDPPort({
         localAddress: "0.0.0.0",
         localPort: 0, // 受信は使わないので自動割り当て
         remoteAddress: VRCHAT_HOST,
         remotePort: VRCHAT_PORT,
      });

      udpPort.on("ready", () => resolve(udpPort));
      udpPort.on("error", reject);
      udpPort.open();
   });
}

// ---- シャッターを切る ----
function sendCapture(udpPort) {
   // VRChatは単一パラメータならbool/int/floatを相互変換して受け付けるため、
   // floatの1.0(true相当)→少し後に0.0(false相当)を送る
   udpPort.send({
      address: "/usercamera/Capture",
      args: [{ type: "f", value: 1.0 }],
   });

   setTimeout(() => {
      udpPort.send({
         address: "/usercamera/Capture",
         args: [{ type: "f", value: 0.0 }],
      });
   }, 50);

   // カメラが未起動の場合、自動でPhotoモードを開きたいならこちらを事前に呼ぶ:
   // udpPort.send({ address: "/usercamera/Mode", args: [{ type: "i", value: 1 }] });
}

// ---- チャットボックスにテキストを送信 ----
function sendChatbox(udpPort, text) {
   udpPort.send({
      address: "/chatbox/input",
      // 注意: osc.jsは { type: "T" } のようにvalue省略のbool指定だとクラッシュするバグがあるため、
      // ここではJSのtrue/falseをそのまま渡して自動的にOSCのT/F型へ変換させる
      args: [text, true, true],
   });
}

// ---- 指定時刻まで待機 ----
// 要求精度: 目標時刻より早く発火しない(-0ms)、遅れは500ms以内。
// CPUを占有するビジーループは使わず、setTimeoutでのポーリングのみで実現する。
// 残り時間が長い間は粗く待ち、直前は細かくポーリングして
// 「Date.now() >= target になった瞬間だけ発火」を保証することで早撃ちを防ぐ。
function sleep(ms) {
   return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

async function waitUntil(targetMs) {
   const FINE_POLL_MS = 100; // 直前の細かいポーリング間隔(この値が遅延の目安上限)
   const FINE_THRESHOLD_MS = 2000; // これより残りが少なくなったら細かいポーリングに切替

   while (true) {
      const remaining = targetMs - Date.now();
      if (remaining <= 0) {
         return; // 目標時刻に到達 (これより早くは絶対にreturnしない)
      }
      if (remaining > FINE_THRESHOLD_MS) {
         // 長時間待機中: 一度に最大30秒まで待ち、定期的に現在時刻を再チェックする
         // (長時間のsetTimeout精度低下やシステム時刻補正に対応するため)
         await sleep(Math.min(remaining - FINE_THRESHOLD_MS, 30000));
      } else {
         await sleep(Math.min(remaining, FINE_POLL_MS));
      }
   }
}

function formatTime(date) {
   return (
      date.toLocaleString("ja-JP", { hour12: false }) +
      "." +
      String(date.getMilliseconds()).padStart(3, "0")
   );
}

// ---- カウントダウン+撮影のタイムラインを組み立てる ----
// offsetMs: 撮影時刻(target)からの相対時間(マイナス=手前)
function buildTimeline(udpPort) {
   return [
      { offsetMs: -60000, action: () => sendCapture(udpPort) },
      { offsetMs: -50000, action: () => sendCapture(udpPort) },
      { offsetMs: -40000, action: () => sendCapture(udpPort) },
      { offsetMs: -30000, action: () => sendCapture(udpPort) },
      { offsetMs: -20000, action: () => sendCapture(udpPort) },
      { offsetMs: -10000, action: () => sendCapture(udpPort) },
      { offsetMs: -6000, action: () => sendChatbox(udpPort, "6秒前") },
      { offsetMs: -5000, action: () => sendChatbox(udpPort, "5") },
      { offsetMs: -4000, action: () => sendChatbox(udpPort, "4") },
      { offsetMs: -3000, action: () => sendChatbox(udpPort, "3") },
      { offsetMs: -2000, action: () => sendChatbox(udpPort, "2") },
      { offsetMs: -1000, action: () => sendChatbox(udpPort, "1") },
      { offsetMs: 0, action: () => sendCapture(udpPort) },
   ];
}

async function main() {
   const arg = process.argv[2];

   let target;
   try {
      target = parseTargetTime(arg);
   } catch (e) {
      console.error("エラー:", e.message);
      process.exit(1);
   }

   console.log(`撮影予定時刻: ${formatTime(target)}`);
   console.log("VRChatへのOSCポートを開いています...");

   const udpPort = await openOscPort();
   const timeline = buildTimeline(udpPort);

   console.log("待機中... (Ctrl+Cで中断できます)");

   for (const event of timeline) {
      const eventTargetMs = target.getTime() + event.offsetMs;

      // 既に過ぎているステップ(開始が遅れた場合の6秒前カウント等)はスキップして
      // 追いつく形にする
      if (Date.now() > eventTargetMs + 500) {
         continue;
      }

      await waitUntil(eventTargetMs);
      const firedAt = new Date();
      event.action();

      if (event.offsetMs === 0) {
         console.log(
            `シャッターを送信しました: ${formatTime(firedAt)} ` +
            `(目標との差: +${firedAt.getTime() - target.getTime()} ms)`
         );
      } else {
         console.log(`チャット送信 [${formatTime(firedAt)}]: "${event.offsetMs === -6000 ? "6秒前" : String(-event.offsetMs / 1000)}"`);
      }
   }

   setTimeout(() => {
      udpPort.close();
      process.exit(0);
   }, 300);
}

main();
