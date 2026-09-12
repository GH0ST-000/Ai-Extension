import type {
  SystemFlowEdge,
  SystemFlowGap,
  SystemFlowNode,
  SystemFlowTrace,
  SystemFlowTrigger,
  MultiRepoAnalysisScope,
} from '@project-x/types';

/** Build a simple linear flow from ordered nodes (A→B→C…). */
export function buildSimpleLinearFlow(input: {
  trigger: SystemFlowTrigger;
  nodes: SystemFlowNode[];
  summary: string;
  scope: MultiRepoAnalysisScope;
  gaps?: SystemFlowGap[];
}): SystemFlowTrace {
  const edges: SystemFlowEdge[] = [];
  for (let i = 0; i < input.nodes.length - 1; i += 1) {
    const from = input.nodes[i];
    const to = input.nodes[i + 1];
    if (!from || !to) continue;
    edges.push({
      fromNodeId: from.id,
      toNodeId: to.id,
      kind: 'sequence',
    });
  }

  return {
    trigger: input.trigger,
    nodes: input.nodes,
    edges,
    summary: input.summary,
    gaps: input.gaps ?? [],
    scope: input.scope,
  };
}

export function appendFlowGap(trace: SystemFlowTrace, gap: SystemFlowGap): SystemFlowTrace {
  return {
    ...trace,
    gaps: [...trace.gaps, gap],
  };
}
