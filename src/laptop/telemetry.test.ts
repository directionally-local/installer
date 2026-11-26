import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { telemetryOff } from "./telemetry.js";

describe("telemetryOff", () => {
  it("follows install.sh: DL_NO_TELEMETRY or DO_NOT_TRACK set to anything but empty, 0 or false, or any CI", () => {
    for (const env of [{ DL_NO_TELEMETRY: "1" }, { DL_NO_TELEMETRY: "yes" }, { DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { CI: "true" }, { CI: "1" }, { CI: "0" }]) {
      assert.equal(telemetryOff(env), true, JSON.stringify(env));
    }
    for (const env of [{}, { DL_NO_TELEMETRY: "" }, { DL_NO_TELEMETRY: "0" }, { DL_NO_TELEMETRY: "false" }, { DO_NOT_TRACK: "0" }, { DO_NOT_TRACK: "false" }, { CI: "" }]) {
      assert.equal(telemetryOff(env), false, JSON.stringify(env));
    }
  });
});
