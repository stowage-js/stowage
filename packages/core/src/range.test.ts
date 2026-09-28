import { expect, test } from "vitest";

import {
  lastByteOf,
  rangeBoundsRefusal,
  rangeCoversWhole,
  rangeHeader,
  rangeStartRefusal,
  wholeSizeOf,
} from "./range.ts";

test.each([
  ["no range", undefined],
  ["a start alone", { start: 0 }],
  ["a start and an end", { start: 2, end: 5 }],
  ["one byte", { start: 3, end: 3 }],
])("takes %s", (_name, range) => {
  expect(rangeBoundsRefusal(range)).toBeUndefined();
});

test.each([
  ["a negative start", { start: -1 }],
  ["a fractional start", { start: 0.5 }],
  ["a start that is no number", { start: Number.NaN }],
  ["a negative end", { start: 0, end: -1 }],
  ["a fractional end", { start: 0, end: 1.5 }],
  ["an end before the start", { start: 5, end: 4 }],
])("refuses %s as an option naming `range`", (_name, range) => {
  expect(rangeBoundsRefusal(range)).toEqual({
    code: "InvalidOption",
    message: "The option `range` takes two whole numbers from zero up, `start` at most `end`",
  });
});

test.each([
  ["at the first byte", { start: 0 }, 1],
  ["at the last byte", { start: 9, end: 20 }, 10],
])("takes a range starting %s", (_name, range, size) => {
  expect(rangeStartRefusal(range, size, "a.txt")).toBeUndefined();
});

test.each([
  ["at the size", { start: 10 }, 10],
  ["beyond the size", { start: 11, end: 12 }, 10],
  ["at all on an empty object", { start: 0 }, 0],
])("refuses a range starting %s as a request naming the key", (_name, range, size) => {
  expect(rangeStartRefusal(range, size, "a.txt")).toEqual({
    code: "InvalidRequest",
    message: `The range starts beyond the ${size} bytes under the key "a.txt"`,
  });
});

test.each([
  ["no range", undefined, 9],
  ["a start alone", { start: 4 }, 9],
  ["an end within the object", { start: 0, end: 3 }, 3],
  ["an end at the last byte", { start: 0, end: 9 }, 9],
  ["an end beyond the object, clipped", { start: 2, end: 50 }, 9],
])("finds the last byte of %s over 10 bytes", (_name, range, last) => {
  expect(lastByteOf(range, 10)).toBe(last);
});

test.each([
  ["a start alone at zero", { start: 0 }],
  ["an end at the last byte", { start: 0, end: 9 }],
  ["an end beyond the object", { start: 0, end: 50 }],
])("the whole of 10 bytes is what %s asks for", (_name, range) => {
  expect(rangeCoversWhole(range, 10)).toBe(true);
});

test.each([
  ["a start past the first byte", { start: 1 }, 10],
  ["an end before the last byte", { start: 0, end: 8 }, 10],
  ["any range over an empty object", { start: 0 }, 0],
])("the whole object is not what %s asks for", (_name, range, size) => {
  expect(rangeCoversWhole(range, size)).toBe(false);
});

test.each([
  [{ start: 0 }, "bytes=0-"],
  [{ start: 5, end: 9 }, "bytes=5-9"],
  [{ start: 3, end: 3 }, "bytes=3-3"],
])("%j goes out as the `Range` field %j", (range, field) => {
  expect(rangeHeader(range)).toBe(field);
});

test.each([
  ["bytes 0-4/10", 10],
  ["bytes 5-9/10", 10],
  [" bytes 0-0/9007199254740991 ", 9007199254740991],
])("the `Content-Range` %j names a whole object of %j bytes", (field, size) => {
  expect(wholeSizeOf(field)).toBe(size);
});

test.each([
  ["no field", null],
  ["an unknown size", "bytes 0-4/*"],
  ["an unsatisfied range", "bytes */10"],
  ["another unit", "items 0-4/10"],
  ["a size above the safe integers", "bytes 0-4/9007199254740993"],
])("%s names no whole size", (_name, field) => {
  expect(wholeSizeOf(field)).toBeUndefined();
});
