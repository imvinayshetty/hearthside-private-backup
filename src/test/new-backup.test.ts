import { expect, it } from "vitest";
import { folderSummary } from "@/components/homesafe/NewBackup";
it("groups a Full backup by top folder, largest first", () => {
  const s = folderSummary([{ name: "DCIM/Camera/a.jpg", bytes: 10 }, { name: "DCIM/Camera/b.jpg", bytes: 5 }, { name: "Pictures/c.png", bytes: 20 }]);
  expect(s).toEqual([{ folder: "Pictures", count: 1, bytes: 20 }, { folder: "DCIM", count: 2, bytes: 15 }]);
});
