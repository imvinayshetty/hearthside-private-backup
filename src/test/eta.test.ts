import { describe, expect, it } from "vitest";
import { createEtaEstimator, formatEta } from "@/lib/eta";

describe("time left", () => {
  it("shows hours, minutes and seconds", () => {
    expect(formatEta(0)).toBe("0h 00m 00s");
    expect(formatEta(3725)).toBe("1h 02m 05s");
    expect(formatEta(36000 + 59 * 60 + 59)).toBe("10h 59m 59s");
  });
  it("smooths the speed and keeps the estimate through a pause", () => {
    const e = createEtaEstimator();
    expect(e.update(0, 10_000_000, 1_000_000)).toBe("0h 00m 10s");
    expect(e.update(5_000_000, 10_000_000, 0)).toBe("0h 00m 05s");
    expect(e.update(10_000_000, 10_000_000, 1_000_000)).toBeNull();
  });
});
