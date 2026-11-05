// Pure, browser-safe helpers behind the three client-only writing tools. No network, no
// credits, no quota: everything here runs on the visitor's text in the visitor's browser.

// ---------------------------------------------------------------------------
// Shared text primitives
// ---------------------------------------------------------------------------

const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** User-perceived characters: an emoji with a skin tone or a ZWJ family counts once. */
export function graphemes(text: string): string[] {
  return graphemeSegmenter ? Array.from(graphemeSegmenter.segment(text), part => part.segment) : Array.from(text);
}

export function graphemeCount(text: string): number {
  return graphemes(text).length;
}

const EMOJI_GRAPHEME = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

export function isEmojiGrapheme(grapheme: string): boolean {
  return EMOJI_GRAPHEME.test(grapheme);
}

export function emojiCount(text: string): number {
  return graphemes(text).filter(isEmojiGrapheme).length;
}

// ---------------------------------------------------------------------------
// Character counter
// ---------------------------------------------------------------------------

export const PLATFORM_LIMITS = {
  x: 280,
  linkedin: 3000,
  linkedinHook: 210,
  threads: 500,
  instagram: 2200,
} as const;
export type CounterPlatform = keyof typeof PLATFORM_LIMITS;
export const COUNTER_PLATFORMS = Object.keys(PLATFORM_LIMITS) as CounterPlatform[];

export const X_URL_WEIGHT = 23;
const X_WEIGHT_SCALE = 100;
const X_DEFAULT_WEIGHT = 200;
const X_EMOJI_WEIGHT = 200;
/** Code point ranges X counts as weight 1 (Latin, general punctuation); everything else is weight 2. */
const X_LIGHT_RANGES: readonly (readonly [number, number])[] = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
const URL_TRAILING = /[.,;:!?)\]}'"”’»]+$/;

/** Split off trailing sentence punctuation so "see example.com/a." does not count the full stop as URL. */
function urlSpans(text: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const trimmed = match[0].replace(URL_TRAILING, "");
    if (trimmed.length > 0) spans.push({ start: match.index, end: match.index + trimmed.length });
  }
  return spans;
}

function xCodePointWeight(codePoint: number): number {
  return X_LIGHT_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to) ? X_WEIGHT_SCALE : X_DEFAULT_WEIGHT;
}

/**
 * Faithful approximation of X's weighted count (the open-source twitter-text v3 rules):
 * every URL counts as 23, emoji count as 2, characters outside the Latin and general
 * punctuation ranges (CJK, Cyrillic-extended scripts, Arabic and others) count as 2, all
 * other characters count as 1. X does its own final count on publish, and it does not
 * auto-link every domain this approximation does not see (for example a bare "example.com").
 */
export function xWeightedLength(text: string): number {
  let weight = 0;
  let cursor = 0;
  const countPlain = (segment: string) => {
    for (const grapheme of graphemes(segment)) {
      if (isEmojiGrapheme(grapheme)) { weight += X_EMOJI_WEIGHT; continue; }
      for (const char of grapheme) weight += xCodePointWeight(char.codePointAt(0)!);
    }
  };
  for (const { start, end } of urlSpans(text)) {
    countPlain(text.slice(cursor, start));
    weight += X_URL_WEIGHT * X_WEIGHT_SCALE;
    cursor = end;
  }
  countPlain(text.slice(cursor));
  return Math.ceil(weight / X_WEIGHT_SCALE);
}

export type PlatformCount = { platform: CounterPlatform; used: number; limit: number; remaining: number; over: boolean };

export function platformCounts(text: string): PlatformCount[] {
  const plain = graphemeCount(text);
  return COUNTER_PLATFORMS.map(platform => {
    const used = platform === "x" ? xWeightedLength(text) : plain;
    const limit = PLATFORM_LIMITS[platform];
    return { platform, used, limit, remaining: limit - used, over: used > limit };
  });
}

export function wordCount(text: string): number {
  if (!text.trim()) return 0;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    let words = 0;
    for (const part of new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)) if (part.isWordLike) words += 1;
    return words;
  }
  return text.trim().split(/\s+/).length;
}

export const READING_WORDS_PER_MINUTE = 200;

/** Whole seconds at 200 words per minute; 0 for empty text. */
export function readingSeconds(words: number): number {
  return words <= 0 ? 0 : Math.max(1, Math.round((words / READING_WORDS_PER_MINUTE) * 60));
}

/** The text a reader would see before LinkedIn's "see more", cut on a character boundary. */
export function linkedinHookPreview(text: string): { visible: string; hidden: string } {
  const chars = graphemes(text);
  const limit = PLATFORM_LIMITS.linkedinHook;
  return { visible: chars.slice(0, limit).join(""), hidden: chars.slice(limit).join("") };
}

// ---------------------------------------------------------------------------
// LinkedIn text formatter (Mathematical Alphanumeric Symbols)
// ---------------------------------------------------------------------------

export const FORMAT_STYLES = ["bold", "italic", "boldItalic"] as const;
export type FormatStyle = (typeof FORMAT_STYLES)[number];

type StyleBases = { upper: number; lower: number; digit: number | null };
// Sans-serif math alphabets: the ones that read as normal bold and italic on LinkedIn.
// Italic has no digit forms in Unicode, so digits stay as typed there.
const STYLE_BASES: Record<FormatStyle, StyleBases> = {
  bold: { upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  italic: { upper: 0x1d608, lower: 0x1d622, digit: null },
  boldItalic: { upper: 0x1d63c, lower: 0x1d656, digit: 0x1d7ec },
};

function styleChar(char: string, bases: StyleBases): string {
  const code = char.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCodePoint(bases.upper + code - 65);
  if (code >= 97 && code <= 122) return String.fromCodePoint(bases.lower + code - 97);
  if (bases.digit !== null && code >= 48 && code <= 57) return String.fromCodePoint(bases.digit + code - 48);
  return char;
}

/** Letters that Unicode has no math variant for (everything alphabetic outside plain A-Z a-z). */
export function unstyledLetters(text: string): string[] {
  const found = new Set<string>();
  for (const char of text) if (/\p{L}/u.test(char) && !/[A-Za-z]/.test(char) && !isStyledMathChar(char)) found.add(char);
  return [...found];
}

export const TURKISH_SPECIAL_LETTERS = ["ç", "ğ", "ı", "İ", "ö", "ş", "ü", "Ç", "Ğ", "Ö", "Ş", "Ü"] as const;

export function turkishLettersIn(text: string): string[] {
  return unstyledLetters(text).filter(char => (TURKISH_SPECIAL_LETTERS as readonly string[]).includes(char));
}

export function toStyledText(text: string, style: FormatStyle): string {
  const bases = STYLE_BASES[style];
  let out = "";
  for (const char of text) out += styleChar(char, bases);
  return out;
}

const REVERSE = new Map<string, string>();
for (const bases of Object.values(STYLE_BASES)) {
  for (let i = 0; i < 26; i += 1) {
    REVERSE.set(String.fromCodePoint(bases.upper + i), String.fromCharCode(65 + i));
    REVERSE.set(String.fromCodePoint(bases.lower + i), String.fromCharCode(97 + i));
  }
  if (bases.digit !== null) for (let i = 0; i < 10; i += 1) REVERSE.set(String.fromCodePoint(bases.digit + i), String.fromCharCode(48 + i));
}

function isStyledMathChar(char: string): boolean {
  return REVERSE.has(char);
}

/** Back to plain A-Z a-z 0-9, so styled text can be pasted in and cleaned. */
export function toPlainText(text: string): string {
  let out = "";
  for (const char of text) out += REVERSE.get(char) ?? char;
  return out;
}

/** Style only a [start, end) UTF-16 range (a textarea selection); the whole text when the range is empty. */
export function styleRange(text: string, style: FormatStyle | "plain", start: number, end: number): { text: string; start: number; end: number } {
  const apply = (part: string) => style === "plain" ? toPlainText(part) : toStyledText(toPlainText(part), style);
  const from = Math.max(0, Math.min(start, end));
  const to = Math.min(text.length, Math.max(start, end));
  if (from === to) {
    const all = apply(text);
    return { text: all, start: 0, end: all.length };
  }
  const middle = apply(text.slice(from, to));
  return { text: text.slice(0, from) + middle + text.slice(to), start: from, end: from + middle.length };
}

// ---------------------------------------------------------------------------
// Newsletter subject line checker
// ---------------------------------------------------------------------------

export const SUBJECT_DESKTOP_VISIBLE = 60;
export const SUBJECT_MOBILE_VISIBLE = 38;
export const PREVIEW_IDEAL_MIN = 40;
export const PREVIEW_IDEAL_MAX = 90;
export const CAPS_RATIO_WARN = 0.3;
export const MIN_CAPS_LETTERS = 6;
export const SHOUT_WORD_MIN_LETTERS = 4;

export type CheckStatus = "good" | "warn" | "info";

export type SubjectAnalysis = {
  length: number;
  desktop: { status: CheckStatus; cutAt: number | null };
  mobile: { status: CheckStatus; cutAt: number | null };
  preview: { length: number; status: CheckStatus; band: "empty" | "short" | "ideal" | "long" };
  caps: { ratio: number; letters: number; shoutWords: number; status: CheckStatus };
  punctuation: { exclamations: number; questions: number; repeated: boolean; status: CheckStatus };
  emoji: { count: number; status: CheckStatus };
};

export function capsStats(text: string): { ratio: number; letters: number } {
  let cased = 0;
  let upper = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    const isUpper = /\p{Lu}/u.test(char);
    const isLower = /\p{Ll}/u.test(char);
    if (!isUpper && !isLower) continue; // uncased scripts (CJK, Arabic) never count as shouting
    cased += 1;
    if (isUpper) upper += 1;
  }
  return { ratio: cased ? upper / cased : 0, letters: cased };
}

/** Words of 4+ cased letters that are entirely uppercase ("FREE", "BÜYÜK"); short acronyms like API do not count. */
export function shoutWordCount(text: string): number {
  return text.split(/\s+/).filter(word => {
    const letters = Array.from(word).filter(char => /\p{Lu}|\p{Ll}/u.test(char));
    return letters.length >= SHOUT_WORD_MIN_LETTERS && letters.every(char => /\p{Lu}/u.test(char));
  }).length;
}

export function analyzeSubject(subject: string, preview: string): SubjectAnalysis {
  const subjectChars = graphemes(subject.trim());
  const length = subjectChars.length;
  const previewLength = graphemeCount(preview.trim());
  const caps = capsStats(subject);
  const shoutWords = shoutWordCount(subject);
  const exclamations = (subject.match(/[!！]/g) ?? []).length;
  const questions = (subject.match(/[?？]/g) ?? []).length;
  const repeated = /[!！?？]{2,}|[.…]{4,}/.test(subject);
  const emoji = subjectChars.filter(isEmojiGrapheme).length;
  const band = previewLength === 0 ? "empty" : previewLength < PREVIEW_IDEAL_MIN ? "short" : previewLength > PREVIEW_IDEAL_MAX ? "long" : "ideal";
  return {
    length,
    desktop: length > SUBJECT_DESKTOP_VISIBLE ? { status: "warn", cutAt: SUBJECT_DESKTOP_VISIBLE } : { status: "good", cutAt: null },
    mobile: length > SUBJECT_MOBILE_VISIBLE ? { status: "warn", cutAt: SUBJECT_MOBILE_VISIBLE } : { status: "good", cutAt: null },
    preview: { length: previewLength, band, status: band === "ideal" ? "good" : band === "empty" ? "info" : "warn" },
    caps: { ...caps, shoutWords, status: caps.letters >= MIN_CAPS_LETTERS && caps.ratio > CAPS_RATIO_WARN && shoutWords > 0 ? "warn" : "good" },
    punctuation: { exclamations, questions, repeated, status: repeated || exclamations > 1 || questions > 1 ? "warn" : "good" },
    emoji: { count: emoji, status: emoji > 2 ? "warn" : "good" },
  };
}
