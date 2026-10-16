// The entry every prototype page loads first: the fonts, the base styles and the top bar. Page scripts import their own on top.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "./base.css";
import { initChrome } from "./chrome.ts";

initChrome();
