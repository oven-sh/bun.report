import { describe, test, expect } from "bun:test";
import { isStdlibPath } from "../backend/sentry";

describe("isStdlibPath", () => {
  test.each([
    // Rust std/core/alloc (bun 1.4.x)
    ["src/rust/library/alloc/src/boxed.rs", true],
    ["src/rust/library/std/src/panicking.rs", true],
    ["src/rust/library/core/src/result.rs", true],
    // Zig stdlib (bun 1.3.x and earlier)
    ["src/deps/zig/lib/std/debug.zig", true],
    // Real bun frames
    ["src/sys/Error.rs", false],
    ["src/runtime/node/node_fs.rs", false],
    ["src/jsc/bindings/bindings.cpp", false],
    ["src/bun.js/node/node_fs.zig", false],
    ["vendor/WebKit/Source/JavaScriptCore/runtime/CallData.cpp", false],
  ])("%s -> %p", (path, expected) => {
    expect(isStdlibPath(path)).toBe(expected);
  });
});
