import { Injectable, Logger } from '@nestjs/common';
import { findOperation, generateApiExample } from '@project-x/shared';
import type {
  ApiContractDiff,
  ApiGeneratedExample,
  NormalizedApiContract,
  NormalizedApiOperation,
} from '@project-x/types';
import { OPENAPI_MAX_DOCUMENT_BYTES as MAX_BYTES } from '@project-x/types';

import { diffApiContracts } from './lib/diff';
import { normalizeOpenApiDocument } from './lib/normalize';
import { parseOpenApiRaw } from './lib/parse-raw';
import { analyzeApiContractDeterministic } from './lib/risks';
import { OpenApiErrorNormalizer } from './openapi-error-normalizer';
import { OpenApiFetchService } from './openapi-fetch.service';

@Injectable()
export class OpenApiDocumentService {
  private readonly logger = new Logger(OpenApiDocumentService.name);

  constructor(
    private readonly fetchService: OpenApiFetchService,
    private readonly errors: OpenApiErrorNormalizer,
  ) {}

  async parseFromUrl(url: string): Promise<NormalizedApiContract> {
    const { content, sanitizedUrl } = await this.fetchService.fetchDocument(url);
    return this.parseContent(content, { type: 'url', documentUrl: sanitizedUrl });
  }

  parseFromContent(content: string, sourceUrl?: string): NormalizedApiContract {
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
      throw this.errors.toHttpException(
        'API_DOC_TOO_LARGE',
        'This OpenAPI document is too large to analyze safely.',
      );
    }
    return this.parseContent(content, {
      type: 'page',
      documentUrl: sourceUrl,
    });
  }

  getOperation(
    contract: NormalizedApiContract,
    query: { method?: string; path?: string; operationId?: string; id?: string },
  ): NormalizedApiOperation {
    const candidates = contract.operations.filter((op) => {
      if (query.id) return op.id === query.id;
      if (query.operationId && query.method && query.path) {
        return (
          op.operationId === query.operationId ||
          (op.method === query.method.toUpperCase() && op.path === query.path)
        );
      }
      if (query.operationId) return op.operationId === query.operationId;
      if (query.method && query.path) {
        return op.method === query.method.toUpperCase() && op.path === query.path;
      }
      return false;
    });

    if (candidates.length > 1) {
      throw this.errors.toHttpException(
        'API_OPERATION_AMBIGUOUS',
        'More than one endpoint matches the current page. Choose an endpoint.',
      );
    }

    const op = findOperation(contract, query);
    if (!op) {
      throw this.errors.toHttpException(
        'API_OPERATION_NOT_FOUND',
        'Project X could not find that API operation in the OpenAPI document.',
      );
    }
    return op;
  }

  exampleFor(
    contract: NormalizedApiContract,
    operationQuery: {
      method?: string;
      path?: string;
      operationId?: string;
      id?: string;
    },
  ): ApiGeneratedExample {
    const operation = this.getOperation(contract, operationQuery);
    try {
      return generateApiExample(operation);
    } catch {
      throw this.errors.toHttpException(
        'API_EXAMPLE_GENERATION_FAILED',
        'Unable to generate an example for this operation.',
      );
    }
  }

  deterministicRisks(
    contract: NormalizedApiContract,
    scope: 'operation' | 'tag' | 'contract',
    operationQuery?: { method?: string; path?: string; operationId?: string; id?: string },
    tag?: string,
  ) {
    const operation =
      scope === 'operation' && operationQuery ? this.getOperation(contract, operationQuery) : null;
    return analyzeApiContractDeterministic(contract, scope, operation, tag);
  }

  diff(
    base: NormalizedApiContract,
    head: NormalizedApiContract,
    refs: { baseRef: string; headRef: string },
  ): ApiContractDiff {
    return diffApiContracts(base, head, refs);
  }

  private parseContent(
    content: string,
    source: { type: 'url' | 'page'; documentUrl?: string },
  ): NormalizedApiContract {
    let parsed: { document: unknown; format: 'json' | 'yaml' };
    try {
      parsed = parseOpenApiRaw(content);
    } catch {
      throw this.errors.toHttpException(
        'API_DOC_INVALID',
        'The OpenAPI document could not be parsed.',
      );
    }

    try {
      const contract = normalizeOpenApiDocument(parsed.document, source, content);
      this.logger.log({
        msg: 'openapi.document.parsed',
        source: source.type,
        host: source.documentUrl ? safeHost(source.documentUrl) : null,
        hashPrefix: contract.documentHash.slice(0, 12),
        operations: contract.operationCountIncluded,
        totalOperations: contract.operationCountTotal,
        schemas: Object.keys(contract.schemas).length,
        partial: Boolean(contract.partial),
        format: parsed.format,
      });
      return contract;
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      if (message === 'UNSUPPORTED_VERSION') {
        throw this.errors.toHttpException(
          'API_DOC_UNSUPPORTED_VERSION',
          'This OpenAPI version is not supported. Prefer OpenAPI 3.x.',
        );
      }
      throw this.errors.toHttpException(
        'API_DOC_INVALID',
        'The OpenAPI document could not be normalized.',
      );
    }
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
