import test from "node:test";
import assert from "node:assert/strict";
import { parseTheme, resolveTheme } from "../web/src/theme.ts";

test("theme preference accepts only the three modes, otherwise Light", () => {
  for (const value of [null, undefined, "", "Dark", "auto", {}, 1]) assert.equal(parseTheme(value), "light");
  for (const value of ["light", "dark", "system"] as const) assert.equal(parseTheme(value), value);
});

test("only system preference follows the operating system", () => {
  for (const dark of [false, true]) {
    assert.equal(resolveTheme("light", dark), "light");
    assert.equal(resolveTheme("dark", dark), "dark");
    assert.equal(resolveTheme("system", dark), dark ? "dark" : "light");
  }
});
