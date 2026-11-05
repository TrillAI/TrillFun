// 10-code dictionary and text normalisation for radio traffic.
//
// The recognizer writes numbers in whatever form it likes ("10-4", "ten four",
// "104", "1 0 4"). Dispatchers, officers and scanners expect the canonical
// "10-4" form with the correct meaning. This module:
//
//   1. canonicalises every 10-code found in a transcript
//   2. fixes the very common look-alike mistakes (10-4 vs 10-04, "10 fore")
//   3. expands/annotates codes that are ambiguous between agencies
//   4. phonetic alphabet + call sign normalisation ("union seven" -> "Unit 7")
//   5. produces readable meanings for the caption UI

/** Canonical APCO / generic 10-codes. Meanings are the widely used ones. */
export const TEN_CODES = {
  1: 'Receiving poorly',
  2: 'Receiving well',
  3: 'Stop transmitting',
  4: 'Acknowledged / under control',
  5: 'Relay message',
  6: 'Busy, stand by',
  7: 'Out of service',
  8: 'In service',
  9: 'Repeat last transmission',
  10: 'Fight in progress',
  11: 'Dog case / animal complaint',
  12: 'Stand by',
  13: 'Weather / road report',
  14: 'Prowler report',
  15: 'Civil disturbance',
  16: 'Domestic problem',
  17: 'Meet complainant',
  18: 'Complete assignment, available',
  19: 'Return to station',
  20: 'Location',
  21: 'Call by phone',
  22: 'Disregard / cancel',
  23: 'Arrived at scene',
  24: 'Assignment completed',
  25: 'Report in person',
  26: 'Detaining subject',
  27: 'Driver license information',
  28: 'Vehicle registration information',
  29: 'Check records for wanted',
  30: 'Unnecessary use of radio',
  31: 'Crime in progress',
  32: 'Person with gun',
  33: 'Emergency — all units stand by',
  34: 'Riot / major disturbance',
  35: 'Major crime alert',
  36: 'Correct time check',
  37: 'Suspicious vehicle',
  38: 'Stopping suspicious vehicle',
  39: 'Responding to assigned call',
  40: 'Silence — homicide',
  41: 'Beginning tour of duty',
  42: 'Ending tour of duty',
  43: 'Chase / pursuit',
  44: 'Permission to leave patrol',
  45: 'Animal report',
  46: 'Assist motorist',
  47: 'Prisoner in custody',
  48: 'Traffic stop',
  49: 'Traffic accident',
  50: 'Accident — property damage only',
  51: 'Wrecker / tow truck needed',
  52: 'Ambulance needed',
  53: 'Road blocked',
  54: 'Accident — personal injury',
  55: 'Motorist assist',
  56: 'Assist officer',
  57: 'Officer on duty, available',
  58: 'Officer off duty',
  59: 'Suspicious person',
  60: 'Subject in custody',
  61: 'Subject not wanted',
  62: 'Breather / short break',
  63: 'Subject on foot',
  64: 'Burglary in progress',
  65: 'Burglary report',
  66: 'Escort',
  67: 'Fire alarm',
  68: 'Drowning',
  69: 'Message received',
  70: 'Fire / major alarm',
  71: 'Advise nature of fire',
  72: 'Report progress on fire',
  73: 'Smoke report',
  74: 'Negative',
  75: 'Spare',
  76: 'En route',
  77: 'ETA',
  78: 'Need any help?',
  79: 'Notify fire department',
  80: 'Pursuit in progress',
  81: 'Hit and run',
  82: 'Missing person',
  83: 'Found person',
  84: 'Resume normal traffic',
  85: 'Phone contact',
  86: 'Mental subject',
  87: 'Prisoner / jail escape',
  88: 'Wanted person',
  89: 'Narcotics report',
  90: 'Bomb threat',
  91: 'Prisoner transfer',
  92: 'Notify coroner',
  93: 'Shooting',
  94: 'Stabbing',
  95: 'Robbery in progress',
  96: 'Suspicious person with weapon',
  97: 'Domestic violence',
  98: 'Prisoner escape',
  99: 'Wanted / stolen indicated',
  100: 'Malfunctioning traffic signal',
  101: 'Armed robbery',
  102: 'Kidnapping',
  103: 'Larceny',
  104: 'Felony warrant',
  105: 'Misdemeanor warrant',
  106: 'Vehicle use report',
};

export const PHONETIC = {
  alpha: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F',
  golf: 'G', hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K',
  lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q',
  romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W',
  xray: 'X', 'x-ray': 'X', yankee: 'Y', zulu: 'Z',
};

// Spoken number words that commonly replace digits in a 10-code.
const DIGIT_WORDS = {
  zero: '0', oh: '0', o: '0', one: '1', won: '1', two: '2', to: '2', too: '2',
  three: '3', tree: '3', four: '4', for: '4', fore: '4', five: '5', six: '6',
  seven: '7', eight: '8', ate: '8', nine: '9', niner: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14',
  fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19',
  twenty: '20', thirty: '30', forty: '40', fourty: '40', fifty: '50', sixty: '60',
  seventy: '70', eighty: '80', ninety: '90', hundred: '100',
};

const DIGIT_RE_SRC = Object.keys(DIGIT_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|');

// "ten four", "10-4", "10 4", "ten-fifty four"
const TEN_CODE_RE = new RegExp(
  String.raw`\b(?:ten|10)\s*[-–—.,]?\s*((?:\d{1,3})|(?:${DIGIT_RE_SRC})(?:[-\s]?(?:${DIGIT_RE_SRC})){0,2})\b`,
  'gi',
);

/**
 * Turn a spoken number into an integer: "fifty four" -> 54, "1054" -> null,
 * "twenty eight" -> 28, "1 0 4" -> 104. Returns null when it is not a number.
 */
export function spokenNumber(raw) {
  const toks = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (!toks.length) return null;
  // pure digit string: "54", "104", "1 0 4"
  if (toks.every((t) => /^\d+$/.test(t))) {
    // "1 0 4" is spelled digits; "1054" is a single token and ambiguous
    if (toks.length === 1 && toks[0].length > 1) return Number(toks[0]);
    return Number(toks.join(''));
  }
  let total = 0;
  let current = 0;
  let sawWord = false;
  for (const tok of toks) {
    const mapped = DIGIT_WORDS[tok];
    if (mapped === undefined) return null;
    const v = Number(mapped);
    sawWord = true;
    if (v === 100) {
      current = (current || 1) * 100;
      continue;
    }
    if (v >= 10 && v % 10 === 0) current += v; // twenty, thirty ...
    else if (v >= 10) current += v; // eleven..nineteen
    else current += v; // one..nine appended to a decade
    if (current > 200) return null;
  }
  total += current;
  return sawWord ? total : null;
}

/** Convert a spoken/numeric 10-code body into a canonical "10-n" string. */
export function canonicalCode(raw) {
  const n = spokenNumber(raw);
  if (n === null) return null;
  // normalize leading zeros: "04" -> "4", but keep real codes like 100-106
  let code = n;
  if (/^0\d$/.test(String(raw).trim())) code = n % 10;
  if (!code || code > 106) return null;
  return `10-${code}`;
}

// Codes that are famously written with a leading zero in some agencies:
// 10−4 is not 10−04, but radios routinely say "ten twenty" for 10-20.
const ALIASES = new Map([['10-0', '10-4']]);

/** Normalize every 10-code in a line of text to canonical "10-n" form. */
export function normalizeTenCodes(text) {
  if (!text) return text;
  return text
    // "ten fifty four" / "10 54" / "ten-fifty-four" -> 10-54
    .replace(TEN_CODE_RE, (m, body) => {
      const code = canonicalCode(body.replace(/[\s-]+/g, ' '));
      if (!code) return m;
      return ALIASES.get(code) ?? code;
    })
    // "ten four" with no separator and no space (e.g. "10-4copy")
    .replace(/\b10[- ]?(\d{1,3})\b/g, (m, d) => {
      const code = canonicalCode(d);
      return code ?? m;
    });
}

/** Human meaning for a single code, or null. */
export function meaningOf(code) {
  const m = /^10-(\d+)$/.exec(code.trim());
  if (!m) return null;
  return TEN_CODES[Number(m[1])] ?? null;
}

/** All codes present in a text, in order of first appearance. */
export function codesIn(text) {
  const found = [];
  const re = /\b10-(\d{1,3})\b/g;
  let m;
  while ((m = re.exec(text))) {
    const code = `10-${Number(m[1])}`;
    if (!found.includes(code)) found.push(code);
  }
  return found;
}

/**
 * Annotate a transcript with the meaning of each 10-code, on first mention.
 * e.g. "Respond 10-54" -> "Respond 10-54 (accident — personal injury)"
 */
export function annotateCodes(text, { maxAnnotations = 3 } = {}) {
  let n = 0;
  return text.replace(/\b10-(\d{1,3})\b/g, (m) => {
    if (n >= maxAnnotations) return m;
    const meaning = meaningOf(m);
    if (!meaning) return m;
    n += 1;
    return `${m} (${meaning.toLowerCase()})`;
  });
}

/**
 * Normalise call signs: "unit seven", "car 4", "engine twelve" stay readable
 * while the recognizer's "you knit 7" style errors are repaired.
 */
const CALLSIGN_WORDS = {
  'you knit': 'unit', 'you night': 'unit', 'you are knight': 'unit', unit: 'unit',
  'car': 'car', 'engine': 'engine', 'medic': 'medic', 'rescue': 'rescue',
  'truck': 'truck', 'ladder': 'ladder', 'dispatch': 'dispatch',
};
const NUM_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90,
};

export function normalizeCallSigns(text) {
  if (!text) return text;
  let out = text;
  for (const [bad, good] of Object.entries(CALLSIGN_WORDS)) {
    if (bad === good) continue;
    out = out.replace(new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), good);
  }
  // "Unit 7" / "Engine 12" follow with the number in digits, at sentence start
  out = out.replace(/\b(unit|car|engine|medic|rescue|truck|ladder)\s+([a-z]+)\b/gi, (m, kind, w) => {
    const n = NUM_WORDS[w.toLowerCase()];
    return n ? `${kind} ${n}` : m;
  });
  // capitalise call signs at the start of a sentence
  out = out.replace(/^(unit|car|engine|medic|rescue|truck|ladder|dispatch)\b/i, (m) =>
    m.charAt(0).toUpperCase() + m.slice(1).toLowerCase(),
  );
  return out;
}

/** Spoken-letter sequences: "bravo alpha 12" -> "BA 12". */
export function normalizePhonetic(text) {
  if (!text) return text;
  let out = text.replace(
    /\b((?:alpha|bravo|charlie|delta|echo|foxtrot|golf|hotel|india|juliet|juliett|kilo|lima|mike|november|oscar|papa|quebec|romeo|sierra|tango|uniform|victor|whiskey|xray|x-ray|yankee|zulu)\b[\s,-]*){3,}/gi,
    (m) => m.trim().split(/[\s,-]+/).map((w) => PHONETIC[w.toLowerCase()] ?? '').join('') + ' ',
  );
  return out;
}

/** Full pipeline used for every recognized segment. */
export function postProcess(text, { annotate = true } = {}) {
  if (!text) return '';
  let out = text.replace(/\s+/g, ' ').trim();
  out = normalizePhonetic(out);
  out = normalizeCallSigns(out);
  out = normalizeTenCodes(out);
  if (annotate) out = annotateCodes(out);
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (out && !/[.!?]$/.test(out) && /\b(over|out|copy|stand by|ten four)$/i.test(out)) out += '.';
  return out;
}

/** Cheap detector: does this text look like radio traffic? */
export function looksLikeRadio(text) {
  const t = text.toLowerCase();
  return (
    /\b10-\d/.test(t) ||
    /\b(ten four|ten twenty|ten thirty|dispatch|copy that|roger|over|en route|stand by)\b/.test(t)
  );
}

export default {
  TEN_CODES, PHONETIC, normalizeTenCodes, canonicalCode, meaningOf, codesIn,
  annotateCodes, normalizeCallSigns, normalizePhonetic, postProcess, looksLikeRadio,
};
