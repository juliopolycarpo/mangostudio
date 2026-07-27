import type {
  AdapterStrategy,
  AdaptNote,
  AdaptProvenance,
  LibraryLocationId,
  ResourceFormat,
  ResourceKind,
} from '@mangostudio/shared/library';

export interface AdaptInput {
  readonly content: string;
  readonly kind: ResourceKind;
  readonly from: ResourceFormat;
  readonly to: ResourceFormat;
  readonly resourceKey: string;
  readonly sourceLocationId?: LibraryLocationId;
  readonly targetLocationId?: LibraryLocationId;
  readonly userId?: string;
  readonly signal?: AbortSignal;
}

export interface AdaptSuccess {
  readonly ok: true;
  readonly content: string;
  readonly notes: readonly AdaptNote[];
  readonly requiresReview: boolean;
  readonly lossy: boolean;
  readonly provenance?: AdaptProvenance;
}

interface AdaptFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export type AdaptResult = AdaptSuccess | AdaptFailure;

export interface AdapterQuery {
  readonly kind: ResourceKind;
  readonly from: ResourceFormat;
  readonly to: ResourceFormat;
  readonly sourceLocationId?: LibraryLocationId;
  readonly targetLocationId?: LibraryLocationId;
  readonly agentAvailable?: boolean;
  readonly agentRequested?: boolean;
}

export interface FormatAdapter {
  readonly kind: ResourceKind;
  readonly from: ResourceFormat;
  readonly to: ResourceFormat;
  readonly strategy: AdapterStrategy;
  readonly lossy: boolean;
  adapt(input: AdaptInput): AdaptResult | Promise<AdaptResult>;
}

export interface AdapterCatalog {
  strategiesFor(query: AdapterQuery): readonly AdapterStrategy[];
}
