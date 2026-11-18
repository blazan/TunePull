/**
 * Tests for the cookie reader/formatter in extension/lib/cookies.js.
 *
 *   node --test "tests/*.test.mjs"
 *
 * toNetscape is pure, so it runs in plain Node; gatherYoutubeCookies is exercised
 * with a small chrome.cookies stub.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  isAuthCookie,
  toNetscape,
  collectCookieFile,
} from "../extension/lib/cookies.js";

const AUTH_COOKIE = {
  name: "SID",
  value: "secret-value",
  domain: ".youtube.com",
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: 1735689600, // 2025-01-01
};

test("isAuthCookie accepts the session cookies yt-dlp needs", () => {
  for (const name of ["SID", "HSID", "SSID", "APISID", "SAPISID", "SIDCC", "__Secure-3PSID"]) {
    assert.equal(isAuthCookie({ name }), true, name);
  }
});

test("isAuthCookie rejects tracking and preference cookies", () => {
  for (const name of ["PREF", "VISITOR_INFO1_LIVE", "CONSENT", "YSC", ""]) {
    assert.equal(isAuthCookie({ name }), false, name || "(empty)");
  }
  assert.equal(isAuthCookie(null), false);
});

test("toNetscape writes the 7 tab-separated fields", () => {
  const text = toNetscape([AUTH_COOKIE]);
  const line = text.split("\n").find((l) => l.includes("SID"));
  assert.equal(line, "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1735689600\tSID\tsecret-value");
});

test("toNetscape marks session cookies (no expiry) with 0", () => {
  const text = toNetscape([{ ...AUTH_COOKIE, expirationDate: undefined }]);
  assert.match(text.split("\n").find((l) => l.includes("SID")), /\t0\tSID\t/);
});

test("toNetscape adds the leading dot a wildcard domain needs", () => {
  const text = toNetscape([{ ...AUTH_COOKIE, domain: "youtube.com", hostOnly: false }]);
  assert.match(text, /\.youtube\.com\tTRUE\t/);
});

test("toNetscape keeps a host-only cookie dotless and non-wildcard", () => {
  const text = toNetscape([{ ...AUTH_COOKIE, domain: "www.youtube.com", hostOnly: true }]);
  assert.match(text, /www\.youtube\.com\tFALSE\t/);
});

test("toNetscape keeps the header lines", () => {
  const text = toNetscape([AUTH_COOKIE]);
  assert.ok(text.startsWith("# Netscape HTTP Cookie File"));
});

test("toNetscape handles an empty list without throwing", () => {
  assert.ok(toNetscape([]).startsWith("# Netscape"));
  assert.ok(toNetscape(null).startsWith("# Netscape"));
});

test("collectCookieFile filters to auth cookies and counts them", async () => {
  globalThis.chrome = {
    cookies: {
      getAll: async () => [
        AUTH_COOKIE,
        { name: "PREF", value: "x", domain: ".youtube.com", path: "/" },
        { name: "SAPISID", value: "y", domain: ".youtube.com", path: "/" },
      ],
    },
  };

  const { text, count } = await collectCookieFile();
  assert.equal(count, 2, "only the two auth cookies");
  assert.match(text, /SID/);
  assert.match(text, /SAPISID/);
  assert.doesNotMatch(text, /PREF/);
});
