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
  isVideoMode,
  mediaSettings,
  actionTitle,
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

test("buildDownloadPath can produce an .mp4 for video", () => {
  assert.equal(buildDownloadPath("Videos", "Song", ".mp4"), "Videos/Song.mp4");
  assert.equal(buildDownloadPath("", "Song.mp3", ".mp4"), "Song.mp4");
  assert.equal(buildDownloadPath("", "Song.mp4", ".mp3"), "Song.mp3");
  // Anything that is not the video extension stays audio.
  assert.equal(buildDownloadPath("", "Song", ".mkv"), "Song.mp3");
});

test("isVideoMode only trusts the video setting", () => {
  assert.ok(isVideoMode({ mediaType: "video" }));
  assert.ok(!isVideoMode({ mediaType: "audio" }));
  assert.ok(!isVideoMode({}));
  assert.ok(!isVideoMode(undefined));
});

test("mediaSettings resolves folder, template and extension per mode", () => {
  const settings = {
    mediaType: "audio",
    downloadFolder: "Music/YT",
    filenameTemplate: "{artist} - {title}",
    videoFolder: "Videos/YT",
    videoFilenameTemplate: "{title}",
  };

  const audio = mediaSettings(settings);
  assert.equal(audio.video, false);
  assert.equal(audio.ext, ".mp3");
  assert.equal(audio.folder, "Music/YT");
  assert.equal(audio.template, "{artist} - {title}");

  const video = mediaSettings({ ...settings, mediaType: "video" });
  assert.equal(video.video, true);
  assert.equal(video.mediaType, "video");
  assert.equal(video.ext, ".mp4");
  assert.equal(video.folder, "Videos/YT");
  assert.equal(video.template, "{title}");
});

test("mediaSettings falls back to the default template", () => {
  assert.equal(mediaSettings({ mediaType: "video" }).template, DEFAULT_FILENAME_TEMPLATE);
  assert.equal(mediaSettings({}).template, DEFAULT_FILENAME_TEMPLATE);
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

test("actionTitle names the format the current mode produces", () => {
  assert.equal(actionTitle({ mediaType: "audio" }), "Download as MP3");
  assert.equal(actionTitle({ mediaType: "video" }), "Download as MP4 video");
  // An unset or junk value must fall back to the audio default, like isVideoMode.
  assert.equal(actionTitle({}), "Download as MP3");
  assert.equal(actionTitle(undefined), "Download as MP3");
  assert.equal(actionTitle({ mediaType: "VIDEO" }), "Download as MP4 video");
});
