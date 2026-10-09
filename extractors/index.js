import { canExtractByse, extractByse } from "./byse.js";
import { canExtractDataSv, extractDataSv } from "./datasv.js";
import { canExtractMegaPlay, extractMegaPlay, extractMegaPlayDetails } from "./megaplay.js";
import { canExtractNova, extractNova } from "./nova.js";
import { canExtractVidplay, extractVidplay } from "./vidplay.js";
import { canExtractVidmoly, extractVidmoly } from "./vidmoly.js";
import { canExtractRavok, extractRavok } from "./ravok.js";
import { canExtractBlakite, extractBlakite } from "./blakite.js";
import { canExtractRubystm, extractRubystm } from "./rubystm.js";

export { canExtractByse, extractByse } from "./byse.js";
export { canExtractDataSv, extractDataSv } from "./datasv.js";
export { canExtractMegaPlay, extractMegaPlay, extractMegaPlayDetails } from "./megaplay.js";
export { canExtractNova, extractNova } from "./nova.js";
export { canExtractVidplay, extractVidplay } from "./vidplay.js";
export { canExtractVidmoly, extractVidmoly } from "./vidmoly.js";
export { extractFlixcloud } from "./flixcloud.js";
export { canExtractRavok, extractRavok } from "./ravok.js";
export { canExtractBlakite, extractBlakite } from "./blakite.js";
export { canExtractRubystm, extractRubystm } from "./rubystm.js";

const videoExtractors = [
  { name: "byse", matches: canExtractByse, extract: extractByse },
  { name: "datasv", matches: canExtractDataSv, extract: extractDataSv },
  { name: "megaplay", matches: canExtractMegaPlay, extract: extractMegaPlay },
  { name: "vidplay", matches: canExtractVidplay, extract: extractVidplay },
  { name: "vidmoly", matches: canExtractVidmoly, extract: extractVidmoly },
  { name: "nova", matches: canExtractNova, extract: extractNova },
  { name: "ravok", matches: canExtractRavok, extract: extractRavok },
  { name: "blakite", matches: canExtractBlakite, extract: extractBlakite },
  { name: "rubystm", matches: canExtractRubystm, extract: extractRubystm }
];

export function findVideoExtractor(url) {
  return videoExtractors.find((extractor) => extractor.matches(url)) ?? null;
}

