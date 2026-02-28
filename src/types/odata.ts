// =============================================================================
// OData V2 Response Wrappers and Query Option Types
// =============================================================================

/**
 * Standard OData V2 collection response envelope.
 * Wraps an array of entities under `d.results` with an optional inline count.
 */
export interface ODataCollectionResponse<T> {
  d: {
    results: T[];
    /** Inline count returned when $inlinecount=allpages is requested */
    __count?: string;
  };
}

/**
 * Standard OData V2 single-entity response envelope.
 * Wraps a single entity under `d` with optional OData metadata.
 */
export interface ODataSingleResponse<T> {
  d: T & {
    __metadata?: {
      /** Canonical URI of the entity */
      uri: string;
      /** Fully-qualified OData entity type name */
      type: string;
    };
  };
}

/**
 * Standard OData V2 error response envelope.
 */
export interface ODataError {
  error: {
    /** SAP-specific or OData error code */
    code: string;
    message: {
      /** Language tag (e.g. "en") */
      lang: string;
      /** Human-readable error message */
      value: string;
    };
  };
}

/**
 * Common OData V2 system query options.
 * All properties are optional and map to the corresponding $-prefixed query parameters.
 */
export interface ODataQueryOptions {
  /** OData $filter expression (e.g. "Status eq 'STARTED'") */
  $filter?: string;
  /** Comma-separated list of properties to return */
  $select?: string;
  /** Comma-separated navigation properties to expand inline */
  $expand?: string;
  /** Comma-separated sort expressions (e.g. "Name asc, Version desc") */
  $orderby?: string;
  /** Maximum number of entities to return */
  $top?: number;
  /** Number of entities to skip (for paging) */
  $skip?: number;
  /** Request an inline count of matching entities ("allpages" or "none") */
  $inlinecount?: string;
  /** Response format (typically "json") */
  $format?: string;
}
