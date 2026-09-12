import type {
  ArtifactLineageEdge,
  ArtifactLineageGraph,
  ArtifactLineageNode,
  WorkflowArtifactKind,
} from '@project-x/types';

import { RELIABILITY_MAX_ARTIFACT_LINEAGE_NODES } from './budgets';

export function buildArtifactLineage(input: {
  artifacts: ReadonlyArray<{
    id: string;
    kind: WorkflowArtifactKind;
    summary?: string;
    parentArtifactId?: string;
    producedByStepId?: string;
  }>;
}): ArtifactLineageGraph {
  const limited = input.artifacts.slice(0, RELIABILITY_MAX_ARTIFACT_LINEAGE_NODES);
  const nodes: ArtifactLineageNode[] = limited.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    ...(artifact.summary ? { summary: artifact.summary } : {}),
    ...(artifact.producedByStepId ? { producedByStepId: artifact.producedByStepId } : {}),
  }));

  const edges: ArtifactLineageEdge[] = [];
  for (const artifact of limited) {
    if (artifact.parentArtifactId) {
      edges.push({
        fromArtifactId: artifact.parentArtifactId,
        toArtifactId: artifact.id,
        relation: 'derived_from',
      });
    }
  }

  return { nodes, edges };
}

export function linkArtifactParent(
  childId: string,
  parentId: string | undefined,
): { childId: string; parentArtifactId?: string } {
  return parentId ? { childId, parentArtifactId: parentId } : { childId };
}
