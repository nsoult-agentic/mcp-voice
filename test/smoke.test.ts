import { expect, test } from "bun:test";
import { NAME, VERSION } from "../src/index.ts";

test("package identity", () => {
  expect(NAME).toBe("mcp-voice");
  expect(VERSION).toBe("0.1.0");
});
