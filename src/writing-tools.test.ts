import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeSubject, emojiCount, graphemeCount, linkedinHookPreview, platformCounts, readingSeconds,
  styleRange, toPlainText, toStyledText, turkishLettersIn, unstyledLetters, wordCount, xWeightedLength,
} from "./writing-tools.ts";

test("xWeightedLength: plain text counts 1, CJK and emoji count 2, URLs count 23", () => {
  assert.equal(xWeightedLength("hello"), 5);
  assert.equal(xWeightedLength("çğıöşü İ"), 8, "Turkish letters sit in the light range");
  assert.equal(xWeightedLength("你好"), 4);
  assert.equal(xWeightedLength("😀"), 2);
  assert.equal(xWeightedLength("👨‍👩‍👧"), 2, "a ZWJ emoji sequence is one emoji");
  assert.equal(xWeightedLength("https://example.com/a/very/long/path?with=query"), 23);
  assert.equal(xWeightedLength("read https://example.com/x."), 5 + 23 + 1, "trailing full stop is not part of the URL");
  assert.equal(xWeightedLength("a\nb"), 3);
  assert.equal(xWeightedLength(""), 0);
});

test("platformCounts reports limits, remaining and over-limit", () => {
  const counts = Object.fromEntries(platformCounts("x".repeat(300)).map(c => [c.platform, c]));
  assert.equal(counts.x.over, true);
  assert.equal(counts.x.remaining, -20);
  assert.equal(counts.threads.over, false);
  assert.equal(counts.linkedinHook.over, true);
  assert.equal(counts.linkedin.limit, 3000);
  assert.equal(counts.instagram.limit, 2200);
  assert.equal(counts.threads.limit, 500);
  // Plain counting uses user-perceived characters, X uses weights.
  assert.equal(platformCounts("😀")[1].used, 1);
  assert.equal(platformCounts("😀")[0].used, 2);
});

test("words, reading time and the LinkedIn hook cut-off", () => {
  assert.equal(wordCount(""), 0);
  assert.equal(wordCount("one two  three\nfour"), 4);
  assert.equal(readingSeconds(0), 0);
  assert.equal(readingSeconds(200), 60);
  assert.equal(readingSeconds(1), 1);
  const { visible, hidden } = linkedinHookPreview("a".repeat(250));
  assert.equal(graphemeCount(visible), 210);
  assert.equal(graphemeCount(hidden), 40);
  assert.equal(emojiCount("hi 😀 there 🚀"), 2);
});

test("toStyledText maps ASCII letters to math alphanumerics and leaves the rest", () => {
  assert.equal(toStyledText("Hi 1!", "bold"), "𝗛𝗶 𝟭!");
  assert.equal(toStyledText("Hi 1!", "italic"), "𝘏𝘪 1!", "italic has no digits in Unicode");
  assert.equal(toStyledText("Hi", "boldItalic"), "𝙃𝙞");
  assert.equal(toPlainText(toStyledText("Hello World 2026", "bold")), "Hello World 2026");
  assert.equal(toPlainText(toStyledText("Hello", "italic")), "Hello");
  assert.equal(toPlainText(toStyledText("Hello", "boldItalic")), "Hello");
});

test("Turkish letters are left unchanged and reported", () => {
  const styled = toStyledText("Şeker çok güzel", "bold");
  assert.equal(styled, "Ş𝗲𝗸𝗲𝗿 ç𝗼𝗸 𝗴ü𝘇𝗲𝗹");
  assert.deepEqual(turkishLettersIn("Şeker çok güzel ı İ").sort(), ["Ş", "ç", "ı", "İ", "ü"].sort());
  assert.deepEqual(unstyledLetters(styled).sort(), ["Ş", "ç", "ü"].sort(), "styled output is not reported as unstyled");
  assert.deepEqual(turkishLettersIn("plain text"), []);
});

test("styleRange styles a selection only, or everything when nothing is selected", () => {
  const sel = styleRange("make this bold now", "bold", 5, 9);
  assert.equal(sel.text, "make 𝘁𝗵𝗶𝘀 bold now".replace("𝘁", "𝘁").replace("𝘁𝗵𝗶𝘀", toStyledText("this", "bold")));
  assert.equal(sel.start, 5);
  assert.equal(sel.end, 5 + toStyledText("this", "bold").length);
  assert.equal(styleRange("all", "italic", 2, 2).text, toStyledText("all", "italic"));
  // Restyling replaces the old style instead of stacking.
  const once = styleRange("word", "bold", 0, 0).text;
  assert.equal(styleRange(once, "italic", 0, 0).text, toStyledText("word", "italic"));
});

test("analyzeSubject: length thresholds, preview band, caps, punctuation, emoji", () => {
  const calm = analyzeSubject("Your March product update", "Three changes worth a look before Friday this week.");
  assert.equal(calm.length, 25);
  assert.equal(calm.desktop.status, "good");
  assert.equal(calm.mobile.status, "good");
  assert.equal(calm.preview.band, "ideal");
  assert.equal(calm.caps.status, "good");
  assert.equal(calm.punctuation.status, "good");
  assert.equal(calm.emoji.status, "good");

  const long = analyzeSubject("A".repeat(10) + " " + "word ".repeat(15), "");
  assert.equal(long.desktop.status, "warn");
  assert.equal(long.desktop.cutAt, 60);
  assert.equal(long.mobile.cutAt, 38);
  assert.equal(long.preview.band, "empty");

  assert.equal(analyzeSubject("x", "short").preview.band, "short");
  assert.equal(analyzeSubject("x", "p".repeat(91)).preview.band, "long");
  assert.equal(analyzeSubject("x", "p".repeat(90)).preview.band, "ideal");
  assert.equal(analyzeSubject("x", "p".repeat(40)).preview.band, "ideal");

  const loud = analyzeSubject("FREE GIFT inside!!! 🎁🎉🔥", "");
  assert.equal(loud.caps.status, "warn");
  assert.equal(loud.punctuation.status, "warn");
  assert.equal(loud.punctuation.repeated, true);
  assert.equal(loud.emoji.count, 3);
  assert.equal(loud.emoji.status, "warn");
});

test("caps ratio ignores short acronyms and uncased scripts", () => {
  assert.equal(analyzeSubject("Our API is live", "").caps.status, "good");
  assert.equal(analyzeSubject("新製品のお知らせ", "").caps.status, "good");
  assert.equal(analyzeSubject("İSTANBUL'DA BÜYÜK İNDİRİM", "").caps.status, "warn");
});
