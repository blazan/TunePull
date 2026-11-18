/**
 * Tests for the pure helpers in extension/lib/config.js.
 *
 *   node --test tests/
 *
 * These run in plain Node: the functions under test do not touch chrome.*.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFileName,
  buildDownloadPath,
  sanitizeFileName,
  isTrustedHost,
  parseHostList,
  DEFAULT_FILENAME_TEMPLATE,
} from "../extension/lib/config.js";

const TRACK = {
  title: "Bohemian Rhapsody",
  artist: "Queen",
  album: "A Night at the Opera",
};

test("buildFileName uses the default template", () => {
  assert.equal(buildFileName(TRACK), "Queen - Bohemian Rhapsody");
  assert.equal(DEFAULT_FILENAME_TEMPLATE, "{artist} - {title}");
});

test("buildFileName fills each placeholder", () => {
  assert.equal(buildFileName(TRACK, "{title}"), "Bohemian Rhapsody");
  assert.equal(
    buildFileName(TRACK, "{artist} - {album} - {title}"),
    "Queen - A Night at the Opera - Bohemian Rhapsody",
  );
});

test("buildFileName drops separators left by an empty field", () => {
  assert.equal(buildFileName({ title: "Lonely" }, "{artist} - {title}"), "Lonely");
  assert.equal(buildFileName({ title: "Lonely" }, "{artist} {title}"), "Lonely");
  assert.equal(buildFileName({ title: "Lonely" }, "{artist} - {album} - {title}"), "Lonely");
});

test("buildFileName removes brackets that an empty field leaves behind", () => {
  assert.equal(buildFileName({ title: "Solo" }, "{title} [{artist}]"), "Solo");
  assert.equal(buildFileName({ title: "Solo" }, "{title} ({album})"), "Solo");
});

test("buildFileName falls back when the template is blank", () => {
  assert.equal(buildFileName(TRACK, ""), "Queen - Bohemian Rhapsody");
  assert.equal(buildFileName(TRACK, "   "), "Queen - Bohemian Rhapsody");
});

test("buildFileName leaves unknown placeholders alone", () => {
  assert.equal(buildFileName(TRACK, "{artist} {nope}"), "Queen {nope}");
});

test("buildFileName never returns an empty string", () => {
  assert.equal(buildFileName({}, "{artist}"), "Unknown title");
});

test("buildDownloadPath places the file inside the folder", () => {
  assert.equal(buildDownloadPath("", "Song"), "Song.mp3");
  assert.equal(buildDownloadPath("Music/YouTube", "Song"), "Music/YouTube/Song.mp3");
  assert.equal(buildDownloadPath("/Music/YT/", "Song"), "Music/YT/Song.mp3");
  assert.equal(buildDownloadPath("  Music  ", "Song"), "Music/Song.mp3");
});

test("buildDownloadPath cannot escape the Downloads directory", () => {
  assert.equal(buildDownloadPath("../../etc", "Song"), "etc/Song.mp3");
  assert.equal(buildDownloadPath("..\\..\\evil", "Song"), "evil/Song.mp3");
  assert.equal(buildDownloadPath("..", "Song"), "Song.mp3");
  assert.equal(buildDownloadPath("/etc/passwd", "Song"), "etc/passwd/Song.mp3");
});

test("buildDownloadPath always ends in .mp3 exactly once", () => {
  assert.equal(buildDownloadPath("", "Song.mp3"), "Song.mp3");
  assert.equal(buildDownloadPath("Music", "AC/DC: Back"), "Music/AC DC Back.mp3");
});

test("sanitizeFileName strips path-hostile characters", () => {
  assert.equal(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(sanitizeFileName("  ..dots..  "), "dots");
  assert.equal(sanitizeFileName("", "fallback"), "fallback");
});

test("isTrustedHost always allows loopback", () => {
  assert.ok(isTrustedHost("127.0.0.1", []));
  assert.ok(isTrustedHost("localhost", []));
  assert.ok(isTrustedHost("::1", []));
});

test("isTrustedHost only allows explicitly listed hosts", () => {
  assert.ok(isTrustedHost("192.168.1.50", ["192.168.1.50"]));
  assert.ok(isTrustedHost("RaspberryPi.local", ["raspberrypi.local"]));
  assert.ok(!isTrustedHost("evil.example.com", ["192.168.1.50"]));
  assert.ok(!isTrustedHost("192.168.1.51", ["192.168.1.50"]));
});

test("parseHostList splits on commas and whitespace", () => {
  assert.deepEqual(parseHostList("a.local, 10.0.0.1\nb.local"), ["a.local", "10.0.0.1", "b.local"]);
  assert.deepEqual(parseHostList(""), []);
});
