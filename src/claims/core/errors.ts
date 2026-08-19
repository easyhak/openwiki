/**
 * Base error for deterministic Grounded Claims failures.
 */
export class ClaimsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsError";
  }
}

/**
 * Reports invalid or unsafe claim persistence state.
 */
export class ClaimsPersistenceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimsPersistenceError";
  }
}

/**
 * Reports a malformed or unsafe evidence resource.
 */
export class EvidenceResourceError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResourceError";
  }
}

/**
 * Reports an operational failure while resolving otherwise valid evidence.
 */
export class EvidenceResolutionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceResolutionError";
  }
}

/**
 * Reports one source file the language adapter could not parse.
 *
 * A subclass rather than a sibling, because it IS a resolution failure and
 * every existing handler that treats it as one stays correct. What it adds is
 * scope: this file, not the resolver. LangChainPlus commits a literal NUL byte
 * inside a template literal in .github/scripts/ci-blocker/signature.ts, which
 * tree-sitter cannot parse and never will, and that is a property of the
 * repository rather than an outage. A missing grammar or a failed adapter
 * initialization stays an EvidenceResolutionError: those fail every file of a
 * language, and absorbing them would silently ungroundedise a whole wiki.
 *
 * The distinction is what lets one unparseable file cost its own page's claims
 * instead of the whole batch's. Before it existed, a coordinator that hit this
 * wrote its own `evidence.filter(ev => !ev.resource.includes('signature.ts'))`
 * into the retry path, having no other way to make progress.
 */
export class EvidenceParseError extends EvidenceResolutionError {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceParseError";
  }
}

/**
 * Reports an invalid claim mutation or authoring-order violation.
 */
export class ClaimSessionError extends ClaimsError {
  constructor(message: string) {
    super(message);
    this.name = "ClaimSessionError";
  }
}
