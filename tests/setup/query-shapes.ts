// Vitest setup file (every test file): record the Cypher the product sends into the directory the global setup made
// (tests/setup/query-shapes.global.ts reads it after the run). Nothing happens outside a vitest run that has the directory.
import { setQueryObserver } from "../../src/graph/client.js";
import { SHAPES_ENV, shapeRecorder } from "../helpers/query-shapes.js";

const dir = process.env[SHAPES_ENV];
if (dir) setQueryObserver(shapeRecorder(dir));
