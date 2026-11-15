import { describe, expect, it } from "vitest";
import { nativeVault, sessionSchema } from "./local-connection";

describe("real local connection boundary", () => {
  it("does not claim browser preview is native enrollment", () => {
    delete window.HomeSafeNative;
    expect(() => nativeVault()).toThrow(/installed HomeSafe app/);
  });
  it("requires a completed connection before accepting a session", () => {
    expect(sessionSchema.safeParse({ connected: false, email: "a@example.com", profile: "Vinay", phone: "Blue Pixel" }).success).toBe(false);
    expect(sessionSchema.safeParse({ connected: true, email: "a@example.com", profile: "Vinay", phone: "Blue Pixel" }).success).toBe(true);
  });
});