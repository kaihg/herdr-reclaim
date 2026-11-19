// 固定事件情境：herdr-reclaim 的第一條正式縱切（ticket #2）。
//
// 一支互動的 omp root session 進入一座 Git 城（herdr-reclaim），工作 74 分鐘還沒收工；
// 同一座城還有一支互動 fork、一個 task child，另外有 print 與 headless 的 root。
// 依 §6.1：只有互動的 root 與互動的 fork 會建格，child 的工作併入它的 root，
// print／headless 不建格。時間都是相對 AT 的毫秒位移。
//
// heartbeat 只留最後一次：§6.2 說沒有正常關閉的 interval 只算到最後一次寫入磁碟的
// heartbeat，所以重播不需要每一分鐘一筆。

export const AT = 1_795_082_918_000;

/** 這一票的城：canonical git common dir 是城的身份（§1）。 */
export const CITY = {
  commonDir: "/Users/kk/projects/herdr-reclaim/.git",
  checkout: "/Users/kk/projects/herdr-reclaim",
};

export const ROOT_SESSION_ID = "01a1f612-97af-7393-96d9-f54ddbc4cc39";
export const FORK_SESSION_ID = "01a1f700-4c1d-7525-9a1b-2f5f0c7d3e11";
export const CHILD_SESSION_ID = "01a1f614-7616-7195-9073-4f1f65376939";
export const PRINT_SESSION_ID = "01a1f720-9f4e-7c1a-8f2b-5d3c9e0a1b42";
export const HEADLESS_SESSION_ID = "01a1f730-1c2d-7e3f-9a4b-6c5d0e1f2a53";

/** 相對 AT 的時間戳。 */
export const T = (ms) => AT + ms;

export const visitStart = (visitId, at, repo = CITY) => ({
  kind: "visit_start",
  at,
  visit: { visitId, cwd: repo.checkout, commonDir: repo.commonDir, checkout: repo.checkout },
});
export const intervalOpen = (at) => ({ kind: "interval_open", at });
export const heartbeat = (at) => ({ kind: "heartbeat", at });
export const intervalClose = (at) => ({ kind: "interval_close", at });

/**
 * 一支 CLI session 的活動紀錄（§6.1 的欄位；eventSeq 依 events 的順序從 1 開始）。
 * 沒有用到的欄位（用量、turn_end）這一票不填。
 */
export function activity({ sessionId, role = "root", interactive = true, parentSessionId, cli = "omp", writerEpoch, events }) {
  const withSeq = events.map((event, index) => ({ eventSeq: index + 1, ...event }));
  const record = {
    schema: 1,
    cli,
    cliVersion: "18.22.0",
    capabilities: { usage: true, parent: true, heartbeat: true, commitEnv: true },
    sessionId,
    role,
    interactive,
    writerEpoch: writerEpoch ?? `pid-40001@${AT}`,
    events: withSeq,
    updatedAt: withSeq.reduce((latest, event) => Math.max(latest, event.at), AT),
  };
  if (parentSessionId) record.parentSessionId = parentSessionId;
  return record;
}

const root = activity({
  sessionId: ROOT_SESSION_ID,
  role: "root",
  interactive: true,
  events: [visitStart("v-root-1", T(0)), intervalOpen(T(0)), heartbeat(T(4_440_000))],
});

// task child：併入 root，不另建格。它的區間落在 root 已經涵蓋的範圍裡。
const child = activity({
  sessionId: CHILD_SESSION_ID,
  role: "child",
  interactive: false,
  parentSessionId: ROOT_SESSION_ID,
  events: [
    visitStart("v-child-1", T(2_400_000)),
    intervalOpen(T(2_400_000)),
    heartbeat(T(2_700_000)),
    intervalClose(T(2_700_000)),
  ],
});

// 互動 fork：算新的 root，建立自己的格；工作 10 分鐘後收工。
const fork = activity({
  sessionId: FORK_SESSION_ID,
  role: "fork",
  interactive: true,
  parentSessionId: ROOT_SESSION_ID,
  events: [visitStart("v-fork-1", T(60_000)), intervalOpen(T(60_000)), intervalClose(T(660_000))],
});

// print 與 headless 的 root 不是互動 session：保留活動資料，但不建格（§1、§6.1）。
const printRoot = activity({
  sessionId: PRINT_SESSION_ID,
  role: "root",
  interactive: false,
  events: [visitStart("v-print-1", T(0)), intervalOpen(T(0)), intervalClose(T(30_000))],
});

const headlessRoot = activity({
  sessionId: HEADLESS_SESSION_ID,
  role: "root",
  interactive: false,
  events: [visitStart("v-headless-1", T(0)), intervalOpen(T(0)), intervalClose(T(45_000))],
});

/**
 * 重播接點：adapter 的活動紀錄加上「開城時 repo 有沒有 HEAD」。
 * 後者是舊城區（§4）唯一的來源，這一票由情境直接給；#3 之後由 commit 紀錄推得。
 */
export const firstExpedition = {
  repoFacts: { [CITY.commonDir]: { hadHead: true } },
  activities: [root, child, fork, printRoot, headlessRoot],
};
