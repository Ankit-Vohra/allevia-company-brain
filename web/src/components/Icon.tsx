// One small authored icon set: 20×20, 1.5 stroke, round joins.
import type { SVGProps } from "react";

const PATHS = {
  office: "M3 17V7.5L10 3l7 4.5V17M3 17h14M7.5 17v-4h5v4M6 9.5h2M12 9.5h2",
  ask: "M4 4.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM7 8.5h6M7 11h4",
  brain: "M5.5 6a2 2 0 1 0 0-.01M14.5 4.5a2 2 0 1 0 0-.01M14.5 15.5a2 2 0 1 0 0-.01M5 14.5a2 2 0 1 0 0-.01M7.4 6.4l5.2-1.6M6.7 7.6l6.4 6.5M5.5 8v4.5M7 14.5l5.5 1",
  insights: "M3 16h14M5 13l3-4 3 2 4-6M13 5h2v2",
  approvals: "M4 4h12v12H4zM7 10l2 2 4-4.5",
  onboard: "M10 4v12M4 10h12",
  sun: "M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1",
  moon: "M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z",
  system: "M3 4.5h14v9H3zM7.5 16.5h5M10 13.5v3",
  search: "M9 4a5 5 0 1 0 0 10A5 5 0 0 0 9 4ZM12.6 12.6 16.5 16.5",
  send: "M4 10h11M11 6l4 4-4 4",
  chevron: "M7 8l3 3 3-3",
  "chevron-right": "M8 6l4 4-4 4",
  close: "M5.5 5.5l9 9M14.5 5.5l-9 9",
  play: "M6.5 4.5v11l9-5.5z",
  stop: "M5.5 5.5h9v9h-9z",
  replay: "M4.5 10a5.5 5.5 0 1 0 1.6-3.9M4.5 3.5v3h3",
  check: "M4.5 10.5l3.5 3.5 7.5-8",
  warn: "M10 3.5l7 12.5H3zM10 8.5v3.5M10 14.2v.3",
  x: "M6 6l8 8M14 6l-8 8",
  file: "M3.5 6V15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V7.5a1 1 0 0 0-1-1H10L8.5 5h-4a1 1 0 0 0-1 1Z",
  github: "M10 3a7 7 0 0 0-2.2 13.6c.35.07.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.81-.78-1.03-.78-1.03-.64-.43.05-.42.05-.42.7.05 1.07.72 1.07.72.63 1.07 1.64.76 2.04.58.06-.45.24-.76.44-.94-1.55-.18-3.19-.78-3.19-3.46 0-.76.27-1.39.72-1.88-.07-.18-.31-.89.07-1.85 0 0 .59-.19 1.92.72a6.6 6.6 0 0 1 3.5 0c1.33-.91 1.92-.72 1.92-.72.38.96.14 1.67.07 1.85.45.49.72 1.12.72 1.88 0 2.69-1.64 3.28-3.2 3.45.25.22.48.65.48 1.31v1.94c0 .19.13.41.48.34A7 7 0 0 0 10 3Z",
  pen: "M4 16l1-4 8-8 3 3-8 8zM11.5 5.5l3 3",
  pause: "M7 5v10M13 5v10",
  chat: "M4 5h12v8H8l-4 3z",
  menu: "M4 6h12M4 10h12M4 14h12",
  plus: "M10 5v10M5 10h10",
  link: "M8.5 11.5l3-3M7 9.5l-1.5 1.5a2.5 2.5 0 0 0 3.5 3.5L10.5 13M13 10.5l1.5-1.5a2.5 2.5 0 0 0-3.5-3.5L9.5 7",
  sparkle: "M10 3l1.6 4.4L16 9l-4.4 1.6L10 15l-1.6-4.4L4 9l4.4-1.6z",
  clock: "M10 3.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM10 6.5V10l2.5 1.5",
  layers: "M10 3l7 4-7 4-7-4zM3 11l7 4 7-4",
  focus: "M3.5 7V3.5H7M13 3.5h3.5V7M16.5 13v3.5H13M7 16.5H3.5V13M10 8.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  database: "M4 5c0-1.1 2.7-2 6-2s6 .9 6 2-2.7 2-6 2-6-.9-6-2ZM4 5v10c0 1.1 2.7 2 6 2s6-.9 6-2V5M4 10c0 1.1 2.7 2 6 2s6-.9 6-2",
  instagram: "M6 3.5h8A2.5 2.5 0 0 1 16.5 6v8a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 14V6A2.5 2.5 0 0 1 6 3.5ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM13.8 6.2v.1",
  globe: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM3 10h14M10 3c2 2.2 2.8 4.5 2.8 7S12 14.8 10 17c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const solid = name === "github";
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill={solid ? "currentColor" : "none"} stroke={solid ? "none" : "currentColor"} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name]} />
    </svg>
  );
}
