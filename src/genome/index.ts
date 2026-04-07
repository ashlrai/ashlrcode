/**
 * Genome module — genetic AI development loop.
 *
 * The genome is a living project specification that agents read via RAG
 * and evolve via a scribe protocol. Generations are milestone-based.
 * Both the vision document and agent strategies co-evolve.
 */

export { type GenomeManifest, type SectionMeta, type GenerationMeta } from "./manifest.ts";
export { loadManifest, saveManifest, genomeExists, genomeDir } from "./manifest.ts";
export { retrieveSections, injectGenomeContext, formatGenomeForPrompt } from "./retriever.ts";
export { proposeUpdate, consolidateProposals, loadMutations } from "./scribe.ts";
export { startGeneration, evaluateGeneration, endGeneration } from "./generations.ts";
export { measureFitness, compareFitness, type FitnessMetrics } from "./fitness.ts";
export { initGenome, initGenomeFromClaudeMd } from "./init.ts";
export { genomeCommands } from "./commands.ts";
