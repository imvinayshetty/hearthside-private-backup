import { describe, expect, it } from "vitest";
import { speedSummary } from "@/components/homesafe/NewBackup";

const MB = 1048576;
describe("speed test summary", () => {
  it("blames a slow drive, and says when staging protects the phone", () => {
    expect(speedSummary({ networkBytesPerSecond: 20 * MB, driveBytesPerSecond: 2 * MB, stagingBytesPerSecond: 200 * MB, staging: true })).toMatch(/drive is the slowest.*not kept waiting/);
    expect(speedSummary({ networkBytesPerSecond: 20 * MB, driveBytesPerSecond: 2 * MB, staging: false })).toMatch(/faster USB port/);
  });
  it("blames Wi-Fi when the network is the slow part", () => {
    expect(speedSummary({ networkBytesPerSecond: 1 * MB, driveBytesPerSecond: 80 * MB, staging: false })).toMatch(/Wi-Fi is the slowest.*5 GHz/);
  });
  it("shows Wi-Fi 12.0 MB/s with the figures", () => {
    expect(speedSummary({ networkBytesPerSecond: 12 * MB, driveBytesPerSecond: 40 * MB, staging: false })).toMatch(/^Wi-Fi 12\.0 MB\/s · drive 40\.0 MB\/s\./);
  });
});
