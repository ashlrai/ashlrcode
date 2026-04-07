/**
 * Genome module — genetic AI development loop.
 *
 * The genome is a living project specification that agents read via RAG
 * and evolve via a scribe protocol. Generations are milestone-based.
 * Both the vision document and agent strategies co-evolve.
 */

export { genomeCommands } from "./commands.ts";
export { compareFitness, type FitnessMetrics, measureFitness } from "./fitness.ts";
export { endGeneration, evaluateGeneration, startGeneration } from "./generations.ts";
export { initGenome, initGenomeFromClaudeMd } from "./init.ts";
export {
  type GenerationMeta,
  type GenomeManifest,
  genomeDir,
  genomeExists,
  loadManifest,
  type SectionMeta,
  saveManifest,
} from "./manifest.ts";
export { isOllamaAvailable, semanticSearch, updateEmbeddings } from "./embeddings.ts";
export { formatGenomeForPrompt, injectGenomeContext, retrieveSections, retrieveSectionsV2 } from "./retriever.ts";
export { consolidateProposals, loadMutations, loadMutationsForGeneration, proposeUpdate } from "./scribe.ts";
