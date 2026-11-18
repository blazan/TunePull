/**
 * Drives the real service worker against mocked chrome.* + fetch.
 *
 *   node --test "tests/*.test.mjs"
 *
 * This exercises the one-click flow end to end (track -> job -> poll -> save)
 * without a browser or a helper server.
 */

import test from "node:test";
import assert from "node:assert/strict";

const SETTINGS = {
  serverUrl: "http://127.0.0.1:8756",
  serverToken: "tok",
  trustedHosts: [],
  quality: "320",
  downloadFolder: "Music/YouTube",
  filenameTemplate: "{artist} - {title}",
  askWhereToSave: false,
  notifyOnFinish: true,
};

const TRACK = {
  title: "Bohemian Rhapsody",
  artist: "Queen",
  album: "A Night at the Opera",
  videoId: "fJ9rUzIMcZQ",
  pageUrl: "https://music.youtube.com/watch?v=fJ9rUzIMcZQ",
};

/** Install a fresh set of mocks and import background.js. */
async function loadWorker({
  statuses,
  track = TRACK,
  tracks = null,
  settings = SETTINGS,
  downloadOutcome = "complete",
  downloadDelayMs = 0,
}) {
  const calls = {
    downloads: [],
    notifications: [],
    badges: [],
    requests: [],
    cancelledDownloads: [],
  };

  let actionHandler = null;
  let jobCounter = 0;
  let trackIndex = 0;
  let downloadCounter = 0;
  const statusQueue = [...statuses];
  // chrome.downloads.onChanged listeners, so the mock can report completion.
  const downloadListeners = new Set();
  const downloadTimers = new Map();

  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://test/${path}`,
      onMessage: { addListener: () => {} },
    },
    action: {
      setBadgeText: async ({ text }) => calls.badges.push(text),
      setBadgeBackgroundColor: async () => {},
      onClicked: { addListener: (fn) => (actionHandler = fn) },
    },
    commands: { onCommand: { addListener: () => {} } },
    downloads: {
      download: async (opts) => {
        calls.downloads.push(opts);
        const id = ++downloadCounter;
        // Real Chrome reports the terminal state later, via onChanged — after the
        // worker has had a chance to subscribe. A timer (not a microtask) mirrors that.
        const timer = setTimeout(() => {
          const delta =
            downloadOutcome === "complete"
              ? { id, state: { current: "complete" } }
              : { id, state: { current: "interrupted" }, error: { current: downloadOutcome } };
          for (const listener of downloadListeners) listener(delta);
        }, downloadDelayMs);
        downloadTimers.set(id, timer);
        return id;
      },
      onChanged: {
        addListener: (fn) => downloadListeners.add(fn),
        removeListener: (fn) => downloadListeners.delete(fn),
      },
      cancel: async (id) => {
        calls.cancelledDownloads.push(id);
        // Chrome reports USER_CANCELED, not "complete", when the user cancels.
        clearTimeout(downloadTimers.get(id));
        for (const listener of downloadListeners) {
          listener({ id, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } });
        }
      },
    },
    notifications: {
      create: async (opts) => calls.notifications.push(opts),
    },
    tabs: {
      query: async () => [{ id: 1, url: "https://music.youtube.com/watch?v=x" }],
      sendMessage: async () => ({
        ok: true,
        // `tracks` hands out a different song per click, for concurrency tests.
        track: tracks ? tracks[Math.min(trackIndex++, tracks.length - 1)] : track,
      }),
    },
    scripting: { executeScript: async () => [] },
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...settings }) } },
  };

  // Per-job poll counters, so two concurrent jobs advance independently.
  const jobPolls = new Map();

  globalThis.fetch = async (url, opts = {}) => {
    const href = String(url);
    calls.requests.push({ href, method: opts.method || "GET" });
    if (href.includes("/download")) {
      jobCounter += 1;
      return { ok: true, status: 200, json: async () => ({ jobId: `job${jobCounter}` }) };
    }
    if (href.includes("/job/")) {
      const id = href.split("/job/")[1].split("?")[0];
      const seen = jobPolls.get(id) || 0;
      jobPolls.set(id, seen + 1);
      const next = seen < statusQueue.length - 1 ? statusQueue[seen] : statusQueue.at(-1);
      return { ok: true, status: 200, json: async () => next };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Cache-bust so each test gets a fresh module instance and fresh listeners.
  const mod = await import(`../extension/background.js?t=${Math.random()}`);
  assert.ok(actionHandler, "background.js must register chrome.action.onClicked");
  return { mod, calls, run: () => actionHandler(), getJobCount: () => jobCounter };
}

/** Let the fire-and-forget handleAction() promise chain settle. */
function settle(ms = 60) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("one click downloads into the configured folder", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 40 },
      { state: "done", stage: "Ready", percent: 100, filename: "x.mp3" },
    ],
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 1, "exactly one download");
  const dl = calls.downloads[0];
  assert.equal(
    dl.filename,
    "Music/YouTube/Queen - Bohemian Rhapsody.mp3",
    "folder + templated name",
  );
  assert.equal(dl.saveAs, false, "no Save-as dialog unless configured");
  assert.match(dl.url, /\/file\/job1\?token=tok$/, "token passed as a query param");
});

test("progress is shown on the badge and a notification fires on success", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 40 },
      { state: "done", stage: "Ready", percent: 100 },
    ],
  });

  await run();
  await settle();

  assert.ok(calls.badges.includes("40%"), `expected 40% badge, got ${calls.badges}`);
  assert.ok(calls.badges.includes("✓"), `expected a success badge, got ${calls.badges}`);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Saved");
  assert.match(calls.notifications[0].message, /Music\/YouTube\/Queen - Bohemian Rhapsody\.mp3/);
});

test("a server-side error surfaces yt-dlp's message and no file is saved", async () => {
  const { calls, run } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 60 },
      { state: "error", stage: "Failed", error: "HTTP Error 403: Forbidden" },
    ],
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0, "nothing saved on failure");
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Download failed");
  assert.match(calls.notifications[0].message, /403: Forbidden/);
  assert.ok(calls.badges.includes("!"), `expected a failure badge, got ${calls.badges}`);
});

test("askWhereToSave is honoured", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    settings: { ...SETTINGS, askWhereToSave: true, downloadFolder: "" },
  });

  await run();
  await settle();

  assert.equal(calls.downloads[0].saveAs, true);
  assert.equal(calls.downloads[0].filename, "Queen - Bohemian Rhapsody.mp3", "no folder prefix");
});

test("an untrusted server host is refused before any request is made", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", percent: 100 }],
    settings: { ...SETTINGS, serverUrl: "http://evil.example.com:8756", trustedHosts: [] },
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.requests.length, 0, "no request may leave for an untrusted host");
  assert.match(calls.notifications[0].message, /evil\.example\.com/);
});

test("no song on the page produces a helpful notification, not a crash", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", percent: 100 }],
    track: { title: "" },
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].message, /current track/i);
});

test("a repeated click for the same song does not start a second job", async () => {
  const { calls, run, getJobCount } = await loadWorker({
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 10 },
      { state: "done", stage: "Ready", percent: 100 },
    ],
  });

  // Two clicks in the same instant, before the first job has started.
  await Promise.all([run(), run()]);
  await settle();

  assert.equal(getJobCount(), 1, "only one /download POST");
  assert.equal(calls.downloads.length, 1);
});

test("an interrupted transfer is reported as a failure, not a success", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    downloadOutcome: "NETWORK_FAILED",
  });

  await run();
  await settle();

  assert.equal(calls.downloads.length, 1, "the download was attempted");
  assert.equal(calls.notifications.length, 1, "exactly one notification");
  assert.equal(calls.notifications[0].title, "Download failed");
  assert.match(calls.notifications[0].message, /connection dropped/i);
  assert.ok(calls.badges.includes("!"), `expected a failure badge, got ${calls.badges}`);
  assert.ok(!calls.badges.includes("✓"), "must not claim success");
});

test("cancelling the Save-as dialog is silent, not an error", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    settings: { ...SETTINGS, askWhereToSave: true },
    downloadOutcome: "USER_CANCELED",
  });

  await run();
  await settle();

  assert.equal(calls.notifications.length, 0, "no notification when the user cancels");
  assert.ok(!calls.badges.includes("!"), `no failure badge, got ${calls.badges}`);
});

test("a second click cancels a conversion that is still running", async () => {
  const { calls, run } = await loadWorker({
    // Stays "running" forever: only a cancel ends it.
    statuses: [{ state: "running", stage: "Encoding MP3", percent: 95 }],
  });

  const first = run();
  await settle(1000); // let the job start and the first poll tick pass
  await run(); // second click = cancel
  await first;
  await settle();

  assert.ok(
    calls.requests.some((r) => r.href.includes("/cancel/") && r.method === "POST"),
    `expected a POST /cancel, got ${JSON.stringify(calls.requests)}`,
  );
  assert.equal(calls.downloads.length, 0, "no file was fetched");
  assert.equal(calls.notifications.length, 0, "a cancel is silent, not a failure");
  assert.ok(!calls.badges.includes("!"), `no failure badge, got ${calls.badges}`);
});

test("a second click stops the file transfer once it has started", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    downloadDelayMs: 5000, // keep the transfer "in progress"
  });

  const first = run();
  await settle(1000); // let the transfer start
  assert.equal(calls.downloads.length, 1, "the transfer started");
  await run(); // second click = cancel
  await first;
  await settle();

  assert.deepEqual(calls.cancelledDownloads, [1], "Chrome was told to stop the download");
  assert.equal(calls.notifications.length, 0, "a cancel is silent");
});

test("two different songs download at the same time, without waiting", async () => {
  const second = {
    title: "Another One Bites the Dust",
    artist: "Queen",
    album: "The Game",
    videoId: "rY0WxgSXdEE",
    pageUrl: "https://music.youtube.com/watch?v=rY0WxgSXdEE",
  };
  const { calls, run, getJobCount } = await loadWorker({
    // Each job reports "running" until its own second poll, then "done".
    statuses: [
      { state: "running", stage: "Downloading audio", percent: 30 },
      { state: "done", stage: "Ready", percent: 100 },
    ],
    tracks: [TRACK, second],
    downloadDelayMs: 0,
  });

  // Two clicks, back to back, without awaiting the first.
  const first = run();
  await settle(20); // let the first job register, but not finish
  const both = Promise.all([first, run()]);
  await settle();
  await both;
  await settle(1200); // let both poll loops finish (700ms tick each)

  assert.equal(getJobCount(), 2, "both songs were submitted to the server");
  assert.equal(calls.downloads.length, 2, "both files were saved");
  const titles = calls.notifications.map((n) => n.message).join(" | ");
  assert.match(titles, /Bohemian Rhapsody/, "first song saved");
  assert.match(titles, /Another One Bites the Dust/, "second song saved");
});

test("success is announced only after Chrome reports completion", async () => {
  const { calls, run } = await loadWorker({
    statuses: [{ state: "done", stage: "Ready", percent: 100 }],
    downloadOutcome: "complete",
    downloadDelayMs: 400,
  });

  // Do not await: we want to observe the state *before* the download completes.
  const pending = run();
  // The job is polled every 700ms, so wait past the first tick for the transfer to start.
  await settle(1000);
  assert.equal(calls.downloads.length, 1, "the transfer started");
  assert.equal(calls.notifications.length, 0, "no premature 'Saved' notification");

  await pending;
  await settle();
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.notifications[0].title, "Saved");
});
