// This is a fork of vlq.js, which is licensed under the MIT license.
// https://github.com/Rich-Harris/vlq
//
// This adds support to read a single vlq value from a long string
// and return early.

/** @type {Record<string, number>} */
let char_to_integer = {};

/** @type {Record<number, string>} */
let integer_to_char = {};

"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
  .split("")
  .forEach(function (char, i) {
    char_to_integer[char] = i;
    integer_to_char[i] = char;
  });

/** @param {string} string
 *  @returns {[number | null, number]}
 */
export function decodePart(string) {
  let shift = 0;
  let value = 0;

  for (let i = 0; i < string.length; i += 1) {
    let integer = char_to_integer[string[i]];

    if (integer === undefined) {
      return [null, 0];
    }

    const has_continuation_bit = integer & 32;

    integer &= 31;
    value += integer << shift;

    if (has_continuation_bit) {
      shift += 5;
    } else {
      const should_negate = value & 1;
      value >>>= 1;

      if (should_negate) {
        return [value === 0 ? -0x80000000 : -value, i + 1];
      } else {
        return [value, i + 1];
      }
    }
  }

  return [null, 0];
}
