// Canvas colours for the office, in both themes: ledger paper by day, an indigo night office after dark.
import { darken, lighten, oklch } from "../lib/color";

export interface OfficePalette {
  dark: boolean;
  bg: string;
  corridor: string;
  corridorRule: string;
  corridorMargin: string;
  wallCap: string;
  wallFace: string;
  wallFaceLine: string;
  wallShadow: string;
  floor: (hue: number) => string;
  floorAlt: (hue: number) => string;
  roomEdge: (hue: number) => string;
  ink: string;
  ink2: string;
  deskTop: string;
  deskFront: string;
  deskEdge: string;
  chair: string;
  chairShade: string;
  paper: string;
  paperShade: string;
  gold: string;
  goldDark: string;
  goldLight: string;
  leaf: string;
  leafDark: string;
  pot: string;
  screen: string;
  screenGlow: string;
  screenOff: string;
  metal: string;
  metalDark: string;
  wood: string;
  woodDark: string;
  ok: string;
  bad: string;
  warn: string;
  glass: string;
  lampGlow: string;
  rug: string;
  plank: string;
  plankLine: string;
  plankAlt: string;
  lane: string;
  laneEdge: string;
  laneDash: string;
  tileA: string;
  tileB: string;
  rugFill: (hue: number) => string;
  rugEdge: (hue: number) => string;
  carpet: (hue: number) => string;
  sky: string;
}

export function officePalette(): OfficePalette {
  {
    const ink = oklch(0.25, 0.075, 270);
    return {
      dark: false,
      bg: oklch(0.955, 0.009, 265),
      corridor: oklch(0.975, 0.006, 265),
      corridorRule: oklch(0.915, 0.014, 255),
      corridorMargin: oklch(0.8, 0.07, 25),
      wallCap: oklch(0.45, 0.045, 270),
      wallFace: oklch(0.885, 0.018, 265),
      wallFaceLine: oklch(0.85, 0.02, 265),
      wallShadow: oklch(0.8, 0.02, 265, 0.5),
      floor: (h) => oklch(0.945, 0.024, h),
      floorAlt: (h) => oklch(0.925, 0.03, h),
      roomEdge: (h) => oklch(0.86, 0.04, h),
      ink,
      ink2: oklch(0.4, 0.06, 270),
      deskTop: oklch(0.975, 0.006, 265),
      deskFront: oklch(0.86, 0.018, 265),
      deskEdge: oklch(0.42, 0.06, 270),
      chair: oklch(0.36, 0.08, 270),
      chairShade: oklch(0.28, 0.08, 270),
      paper: "#FFFDF6",
      paperShade: oklch(0.9, 0.02, 85),
      gold: oklch(0.72, 0.125, 85),
      goldDark: oklch(0.55, 0.11, 80),
      goldLight: oklch(0.86, 0.1, 90),
      leaf: oklch(0.62, 0.13, 150),
      leafDark: oklch(0.47, 0.11, 155),
      pot: oklch(0.6, 0.1, 45),
      screen: oklch(0.3, 0.07, 265),
      screenGlow: oklch(0.82, 0.08, 230),
      screenOff: oklch(0.42, 0.04, 265),
      metal: oklch(0.8, 0.015, 265),
      metalDark: oklch(0.62, 0.02, 265),
      wood: oklch(0.72, 0.06, 70),
      woodDark: oklch(0.56, 0.06, 60),
      ok: oklch(0.58, 0.13, 152),
      bad: oklch(0.56, 0.17, 27),
      warn: oklch(0.7, 0.14, 65),
      glass: oklch(0.88, 0.04, 230),
      lampGlow: oklch(0.95, 0.06, 90),
      rug: oklch(0.36, 0.08, 270),
      plank: oklch(0.915, 0.03, 80),
      plankLine: oklch(0.885, 0.034, 76),
      plankAlt: oklch(0.905, 0.032, 84),
      lane: oklch(0.965, 0.012, 85),
      laneEdge: oklch(0.86, 0.025, 80),
      laneDash: oklch(0.9, 0.03, 85),
      tileA: oklch(0.975, 0.01, 90),
      tileB: oklch(0.948, 0.02, 80),
      rugFill: (h) => oklch(0.88, 0.06, h),
      rugEdge: (h) => oklch(0.72, 0.1, h),
      carpet: (h) => oklch(0.865, 0.045, h),
      sky: oklch(0.88, 0.06, 235),
    };
  }
}

export { darken, lighten };
