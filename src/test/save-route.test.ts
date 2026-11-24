import { describe, expect, it } from "vitest";
import { stagingAdvice } from "@/components/homesafe/SaveRoute";

const GB = 1024 ** 3;
describe("fast option advice", () => {
  it("waits for the Vault's answer", () => expect(stagingAdvice(undefined).state).toBe("checking"));
  it("falls back to direct when staging cannot help", () => expect(stagingAdvice({ available: false, ready: false }).state).toBe("unavailable"));
  it("asks the owner to choose a HomeSafeTemp folder when the default lacks room, with the numbers", () => {
    const a = stagingAdvice({ available: true, ready: false, needBytes: 12 * GB, freeBytes: 3 * GB });
    expect(a.state).toBe("needs-folder"); expect(a.text).toMatch(/12\.0 GB.*plus 2 GB.*3\.0 GB.*HomeSafeTemp/);
  });
  it("is ready when a folder has room", () => expect(stagingAdvice({ available: true, ready: true, needBytes: GB }).state).toBe("ready"));
});
