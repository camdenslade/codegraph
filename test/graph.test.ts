import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ingest } from "../src/ingest/index.js";
import { dumpGraph } from "../src/query/dump.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = join(here, "fixtures", "tiny");

describe("tiny fixture", () => {
  beforeAll(() => {
    // Redirect the cache to a temp dir so the real cache is untouched.
    process.env.CODEGRAPH_CACHE_DIR = mkdtempSync(join(tmpdir(), "codegraph-test-"));
    ingest(FIXTURE, { fresh: true });
  });

  it("produces the expected graph", () => {
    expect(dumpGraph(FIXTURE)).toMatchSnapshot();
  });

  it("resolves every call in the fixture except the dynamic one", () => {
    const dump = dumpGraph(FIXTURE);
    const callMisses = dump.unresolved.filter((u) => u.kind === "call");
    expect(callMisses).toHaveLength(1);
    expect(callMisses[0]!.text).toBe("mystery");
  });
});