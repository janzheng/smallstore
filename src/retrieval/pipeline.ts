/**
 * RetrievalPipeline — chain multiple RetrievalProviders in sequence.
 *
 * Each step feeds its output.data as the next step's input.data.
 * Query, vector, and collection are carried forward through all steps.
 */

import type {
  RetrievalProvider,
  RetrievalInput,
  RetrievalOutput,
  RetrievalOutputMeta,
  PipelineStep,
} from './types.ts';

export class RetrievalPipeline {
  private steps: PipelineStep[] = [];
  private registry: Map<string, RetrievalProvider>;

  constructor(registry?: Map<string, RetrievalProvider>) {
    this.registry = registry ?? new Map();
  }

  /** Add a step. Provider can be a name (resolved at execution) or instance. */
  add(
    provider: RetrievalProvider | string,
    options?: Record<string, any>,
  ): this {
    this.steps.push({ provider, options });
    return this;
  }

  /** Resolve a step's provider — string names are looked up in registry */
  private resolve(step: PipelineStep): RetrievalProvider {
    if (typeof step.provider === 'string') {
      const resolved = this.registry.get(step.provider);
      if (!resolved) {
        throw new Error(
          `Retrieval provider "${step.provider}" not found in registry. ` +
          `Available: ${[...this.registry.keys()].join(', ') || '(none)'}`,
        );
      }
      return resolved;
    }
    return step.provider;
  }

  /** Execute all steps in sequence */
  async execute(input: RetrievalInput): Promise<RetrievalOutput> {
    if (this.steps.length === 0) {
      return {
        data: input.data ?? null,
        metadata: {
          provider: 'pipeline',
          type: 'transform',
          itemsReturned: Array.isArray(input.data) ? input.data.length : (input.data != null ? 1 : 0),
        },
      };
    }

    const pipelineStart = performance.now();
    const stepMetadata: RetrievalOutputMeta[] = [];

    let currentInput: RetrievalInput = { ...input };
    let lastOutput: RetrievalOutput | null = null;

    for (const step of this.steps) {
      const provider = this.resolve(step);

      lastOutput = await provider.retrieve(currentInput, step.options);
      stepMetadata.push(lastOutput.metadata);

      // Feed output to next step — carry forward query/vector/collection
      currentInput = {
        data: lastOutput.data,
        query: currentInput.query,
        vector: currentInput.vector,
        collection: currentInput.collection,
        pipelineMetadata: {
          ...currentInput.pipelineMetadata,
          [`step:${stepMetadata.length - 1}`]: lastOutput.metadata,
        },
      };
    }

    if (!lastOutput) {
      return { data: [], metadata: { provider: 'pipeline', type: 'empty', stepCount: 0, itemsReturned: 0 } };
    }

    return {
      data: lastOutput.data,
      metadata: {
        provider: 'pipeline',
        type: lastOutput.metadata.type,
        itemsReturned: lastOutput.metadata.itemsReturned,
        itemsTotal: stepMetadata[0]?.itemsTotal,
        executionTimeMs: performance.now() - pipelineStart,
        steps: stepMetadata,
      },
    };
  }

  /** Create pipeline from step definitions (for serialization/HTTP) */
  static fromSteps(
    steps: PipelineStep[],
    registry?: Map<string, RetrievalProvider>,
  ): RetrievalPipeline {
    const pipeline = new RetrievalPipeline(registry);
    for (const step of steps) {
      pipeline.steps.push(step);
    }
    return pipeline;
  }
}
