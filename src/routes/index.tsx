import { createFileRoute } from "@tanstack/react-router";
import { HomeSafe } from "@/components/homesafe/HomeSafe";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "HomeSafe (Mobile) — Private phone backup on your home Wi-Fi" },
      { name: "description", content: "Back up your phone to a drive at home. Local Wi-Fi only, two-factor unlock, zero cloud." },
      { property: "og:title", content: "HomeSafe (Mobile) — Private phone backup on your home Wi-Fi" },
      { property: "og:description", content: "Back up your phone to a drive at home. Local Wi-Fi only, two-factor unlock, zero cloud." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomeSafe,
});
