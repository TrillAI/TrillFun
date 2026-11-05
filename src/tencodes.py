"""10-code parsing shared by the benchmark and the ASR worker.

Mirrors src/tenCodes.js so accuracy can be measured the same way the app
post-processes transcripts.
"""
import re

CODE_WORDS = {
    "zero": 0, "oh": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11,
    "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
    "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30,
    "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_TOKEN = "|".join(sorted(CODE_WORDS, key=len, reverse=True))
_TEN = re.compile(rf"\b(?:ten|10)\s*[-]?\s*(\d{{1,3}}|(?:{_TOKEN})(?:[\s-]+(?:{_TOKEN}))?)\b", re.I)


def _num(expr):
    parts = [p for p in re.split(r"[\s-]+", expr.lower()) if p]
    if len(parts) == 1 and parts[0].isdigit():
        return int(parts[0])
    if parts[0].isdigit():
        return int(parts[0])
    if len(parts) == 2 and parts[0] in ("twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"):
        return CODE_WORDS[parts[0]] + CODE_WORDS.get(parts[1], 0)
    if len(parts) == 1:
        return CODE_WORDS.get(parts[0])
    return None


def expected_codes(text):
    """Canonical 10-n codes spoken in a line of text, in order."""
    out = []
    for m in _TEN.finditer(text):
        n = _num(m.group(1))
        if n is not None and 1 <= n <= 106:
            code = f"10-{n}"
            if code not in out:
                out.append(code)
    return out
