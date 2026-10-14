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
}

export function officePalette(dark: boolean): OfficePalette {
  if (!dark) {
    const ink = oklch(0.25, 0.075, 270);
    return {
      dark,
      bg: oklch(0.955, 0.009, 265),
      corridor: oklch(0.975, 0.006, 265),
      corridorRule: oklch(0.915, 0.014, 255),
      corridorMargin: oklch(0.8, 0.07, 25),
      wallCap: ink,
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
    };
  }
  const ink = oklch(0.12, 0.04, 272);
  return {
    dark,
    bg: oklch(0.15, 0.04, 272),
    corridor: oklch(0.22, 0.045, 272),
    corridorRule: oklch(0.26, 0.05, 268),
    corridorMargin: oklch(0.4, 0.08, 25),
    wallCap: ink,
    wallFace: oklch(0.3, 0.055, 270),
    wallFaceLine: oklch(0.27, 0.05, 270),
    wallShadow: oklch(0.08, 0.03, 270, 0.45),
    floor: (h) => oklch(0.27, 0.045, h),
    floorAlt: (h) => oklch(0.25, 0.045, h),
    roomEdge: (h) => oklch(0.33, 0.06, h),
    ink: oklch(0.1, 0.035, 272),
    ink2: oklch(0.2, 0.05, 270),
    deskTop: oklch(0.42, 0.04, 265),
    deskFront: oklch(0.32, 0.04, 265),
    deskEdge: oklch(0.14, 0.04, 270),
    chair: oklch(0.2, 0.06, 270),
    chairShade: oklch(0.15, 0.05, 270),
    paper: oklch(0.9, 0.02, 85),
    paperShade: oklch(0.75, 0.03, 85),
    gold: oklch(0.79, 0.13, 85),
    goldDark: oklch(0.6, 0.12, 80),
    goldLight: oklch(0.9, 0.1, 90),
    leaf: oklch(0.52, 0.11, 150),
    leafDark: oklch(0.38, 0.09, 155),
    pot: oklch(0.45, 0.08, 45),
    screen: oklch(0.16, 0.05, 265),
    screenGlow: oklch(0.8, 0.1, 230),
    screenOff: oklch(0.25, 0.04, 265),
    metal: oklch(0.5, 0.02, 265),
    metalDark: oklch(0.36, 0.02, 265),
    wood: oklch(0.45, 0.05, 70),
    woodDark: oklch(0.34, 0.05, 60),
    ok: oklch(0.75, 0.14, 152),
    bad: oklch(0.7, 0.16, 27),
    warn: oklch(0.8, 0.14, 70),
    glass: oklch(0.35, 0.06, 250),
    lampGlow: oklch(0.6, 0.09, 85),
    rug: oklch(0.2, 0.06, 270),
  };
}

export { darken, lighten };
