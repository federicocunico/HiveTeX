import type { ProjectModel } from '@hivetex/sync';
import { type ApplyChoices, type ApplyResult, type BlobWriter, type ImportPlan, buildOps, planImport } from './plan.js';
import type { ImportBundle } from './sources.js';

/** Plans an import against the model's current tree. */
export function planFor(model: ProjectModel, bundle: ImportBundle): Promise<ImportPlan> {
  return planImport(bundle, model.list(), async (id) => (await model.openText(id)).toString());
}

/** Applies a confirmed plan: blobs first, then one coherent batch on the CRDT. */
export async function applyImport(
  model: ProjectModel,
  putBlob: BlobWriter,
  plan: ImportPlan,
  choices: ApplyChoices,
  onProgress?: (done: number, total: number) => void,
): Promise<ApplyResult> {
  const { ops, result } = await buildOps(plan, choices, putBlob, onProgress);
  if (ops.length > 0) await model.applyBatch(ops);
  return result;
}
