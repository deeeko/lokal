// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/**
 * @title LokalText
 * @notice The text rules shared by LokalTags (tags and display names) and LokalPots (pot titles), so both contracts
 * agree with each other and with the site byte for byte.
 * @dev Internal functions only: they are compiled into each contract that uses them (no library deployment).
 */
library LokalText {
    /**
     * @dev Tag format, same as the site's `ntagError` minus the reserved list: `minLength`-`maxLength` bytes of
     * [a-z0-9_], starting with a letter, no "__", not ending in "_". At most `maxLength` iterations.
     */
    function isValidTag(bytes calldata b, uint256 minLength, uint256 maxLength) internal pure returns (bool) {
        uint256 n = b.length;
        if (n < minLength || n > maxLength) return false;
        bytes1 first = b[0];
        if (first < 0x61 || first > 0x7a) return false; // a-z
        if (b[n - 1] == 0x5f) return false; // trailing "_"
        bool prevUnderscore;
        for (uint256 i = 1; i < n; ++i) {
            bytes1 ch = b[i];
            if (ch == 0x5f) {
                if (prevUnderscore) return false; // "__"
                prevUnderscore = true;
            } else {
                if (!((ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39))) return false; // a-z, 0-9
                prevUnderscore = false;
            }
        }
        return true;
    }

    /**
     * @dev Display text (a name or a title): non-empty, well-formed UTF-8, at most `maxBytes` bytes and `maxUnits`
     * UTF-16 code units (JavaScript's `length`, which the site uses), no control characters (U+0000-U+001F,
     * U+007F-U+009F), no invisible or text-direction characters (see `isInvisible`), and no whitespace at either end
     * by JavaScript's `trim()` definition (the site trims before sending, so the stored text is exactly what the site
     * shows). The loop is bounded by `maxBytes`.
     */
    function isValidText(bytes calldata b, uint256 maxBytes, uint256 maxUnits) internal pure returns (bool) {
        uint256 n = b.length;
        if (n == 0 || n > maxBytes) return false;
        uint256 units;
        uint256 i;
        uint256 first = type(uint256).max;
        uint256 cp;
        while (i < n) {
            uint256 c = uint8(b[i]);
            if (c < 0x80) {
                if (c < 0x20 || c == 0x7f) return false; // C0 controls and DEL
                cp = c;
                i += 1;
                units += 1;
            } else if (c >= 0xc2 && c <= 0xdf) {
                if (i + 1 >= n) return false;
                uint256 c1 = uint8(b[i + 1]);
                if (c1 & 0xc0 != 0x80) return false;
                cp = ((c & 0x1f) << 6) | (c1 & 0x3f);
                if (cp <= 0x9f) return false; // C1 controls U+0080-U+009F
                i += 2;
                units += 1;
            } else if (c >= 0xe0 && c <= 0xef) {
                if (i + 2 >= n) return false;
                uint256 c1 = uint8(b[i + 1]);
                uint256 c2 = uint8(b[i + 2]);
                if (c1 & 0xc0 != 0x80 || c2 & 0xc0 != 0x80) return false;
                cp = ((c & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
                if (cp < 0x800) return false; // overlong
                if (cp >= 0xd800 && cp <= 0xdfff) return false; // UTF-16 surrogates
                i += 3;
                units += 1;
            } else if (c >= 0xf0 && c <= 0xf4) {
                if (i + 3 >= n) return false;
                uint256 c1 = uint8(b[i + 1]);
                uint256 c2 = uint8(b[i + 2]);
                uint256 c3 = uint8(b[i + 3]);
                if (c1 & 0xc0 != 0x80 || c2 & 0xc0 != 0x80 || c3 & 0xc0 != 0x80) return false;
                cp = ((c & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
                if (cp < 0x10000 || cp > 0x10ffff) return false; // overlong, or above U+10FFFF
                i += 4;
                units += 2; // a surrogate pair in UTF-16
            } else {
                return false; // continuation byte out of place, 0xc0/0xc1, or 0xf5-0xff
            }
            if (isInvisible(cp)) return false;
            if (first == type(uint256).max) first = cp;
        }
        return units <= maxUnits && !isTrimmedSpace(first) && !isTrimmedSpace(cp);
    }

    /**
     * @dev Invisible formatting and text-direction characters, refused anywhere in a name or title because they let
     * one string look like another: U+200B-U+200F (zero-width space/joiners, LRM/RLM), U+202A-U+202E (bidi embeddings
     * and overrides), U+2060-U+2069 (word joiner, invisible operators, bidi isolates) and U+FEFF (zero-width no-break
     * space). The site's `ntagNameError` refuses the same set.
     */
    function isInvisible(uint256 cp) internal pure returns (bool) {
        return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069)
            || cp == 0xfeff;
    }

    /**
     * @dev Whitespace that JavaScript's `String.prototype.trim()` removes, other than the control characters already
     * refused: U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
     */
    function isTrimmedSpace(uint256 cp) internal pure returns (bool) {
        return cp == 0x20 || cp == 0xa0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp == 0x2028 || cp == 0x2029
            || cp == 0x202f || cp == 0x205f || cp == 0x3000 || cp == 0xfeff;
    }
}
