import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INPUT_FILE, OUTPUT_FILE } from "./config.js";

describe("default dataset config", () => {
  it("uses the English aptitude dataset by default", () => {
    assert.match(INPUT_FILE, /video-aptitude-english\.json$/);
    assert.match(OUTPUT_FILE, /video-aptitude-english-yt\.json$/);
  });
});
