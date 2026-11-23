import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DriveCard } from "@/components/homesafe/DriveCard";
it("shows the connected drive with free space, and a warning when it is unplugged", () => {
  const { rerender } = render(<DriveCard status={{ connected: true, driveName: "Seagate", freeBytes: 500e9, totalBytes: 2e12 }} />);
  expect(screen.getByText(/Connected drive · Seagate/)).toBeTruthy();
  expect(screen.getByText(/500\.0 GB free of 2\.00 TB/)).toBeTruthy();
  rerender(<DriveCard status={{ connected: false, driveName: "Seagate" }} />);
  expect(screen.getByText(/Drive not connected/)).toBeTruthy();
  rerender(<DriveCard status={null} />);
  expect(screen.queryByLabelText("Connected drive")).toBeNull();
});
