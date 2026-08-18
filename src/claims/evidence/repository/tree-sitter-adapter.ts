import Parser from "tree-sitter";
import {
  EvidenceParseError,
  EvidenceResolutionError,
  EvidenceResourceError,
} from "../../core/errors.js";

/**
 * Source fragment and stable syntax representation returned by a language adapter.
 */
export interface SymbolResolution {
  /**
   * Exact source text owned by the resolved declaration.
   */
  content: string;

  /**
   * Whitespace-insensitive syntax serialization used for version hashing.
   */
  normalized: string;
}

/**
 * Resolution result supported by native and future asynchronous adapters.
 */
export type LanguageEvidenceResolution =
  SymbolResolution | null | Promise<SymbolResolution | null>;

/**
 * Language-specific symbol resolver used behind repository evidence.
 */
export interface LanguageEvidenceAdapter {
  /**
   * Stable adapter and normalization algorithm identifier.
   */
  id: string;

  /**
   * Lowercase source extensions handled by the adapter.
   */
  extensions: readonly string[];

  /**
   * Resolves one unique logical declaration.
   *
   * @param input - Source path, content, and requested symbol.
   * @returns Resolved declaration, or `null` when missing or ambiguous.
   */
  resolveSymbol(input: {
    /**
     * Repository-relative source path.
     */
    path: string;

    /**
     * Complete current source text.
     */
    source: string;

    /**
     * Simple or dotted logical symbol name.
     */
    symbol: string;
  }): LanguageEvidenceResolution;
}

/**
 * Declaration node types that can establish a stable logical source identity.
 */
const JAVASCRIPT_DECLARATIONS = declarationFields({
  abstract_class_declaration: ["name"],
  abstract_method_signature: ["name"],
  class_declaration: ["name"],
  enum_declaration: ["name"],
  field_definition: ["property"],
  function_declaration: ["name"],
  function_signature: ["name"],
  generator_function_declaration: ["name"],
  interface_declaration: ["name"],
  internal_module: ["name"],
  method_definition: ["name"],
  method_signature: ["name"],
  property_signature: ["name"],
  public_field_definition: ["name"],
  type_alias_declaration: ["name"],
  variable_declarator: ["name"],
});

/**
 * Declaration node types and the fields that may contain their logical names.
 */
export type DeclarationNameFields = ReadonlyMap<string, readonly string[]>;

/**
 * Direct named-child paths used by grammars that do not expose name fields.
 */
type DeclarationNamePaths = ReadonlyMap<string, readonly (readonly string[])[]>;

/**
 * Native Tree-sitter language accepted by the parser runtime.
 */
type TreeSitterLanguage = object;

/**
 * Loads one native grammar when a symbol in that language is first resolved.
 */
type TreeSitterLanguageLoader = () =>
  TreeSitterLanguage | Promise<TreeSitterLanguage>;

const PYTHON_DECLARATIONS = declarationFields({
  class_definition: ["name"],
  function_definition: ["name"],
});

const GO_DECLARATIONS = declarationFields({
  const_spec: ["name"],
  field_declaration: ["name"],
  function_declaration: ["name"],
  method_declaration: ["name"],
  method_elem: ["name"],
  type_alias: ["name"],
  type_spec: ["name"],
  var_spec: ["name"],
});

const RUST_DECLARATIONS = declarationFields({
  associated_type: ["name"],
  const_item: ["name"],
  enum_item: ["name"],
  enum_variant: ["name"],
  field_declaration: ["name"],
  function_item: ["name"],
  function_signature_item: ["name"],
  macro_definition: ["name"],
  mod_item: ["name"],
  static_item: ["name"],
  struct_item: ["name"],
  trait_item: ["name"],
  type_item: ["name"],
  union_item: ["name"],
});

const JAVA_DECLARATIONS = declarationFields({
  annotation_type_declaration: ["name"],
  annotation_type_element_declaration: ["name"],
  class_declaration: ["name"],
  compact_constructor_declaration: ["name"],
  constant_declaration: ["declarator"],
  constructor_declaration: ["name"],
  enum_constant: ["name"],
  enum_declaration: ["name"],
  field_declaration: ["declarator"],
  interface_declaration: ["name"],
  method_declaration: ["name"],
  module_declaration: ["name"],
  record_declaration: ["name"],
});

const C_SHARP_DECLARATIONS = declarationFields({
  class_declaration: ["name"],
  constructor_declaration: ["name"],
  delegate_declaration: ["name"],
  destructor_declaration: ["name"],
  enum_declaration: ["name"],
  enum_member_declaration: ["name"],
  event_declaration: ["name"],
  file_scoped_namespace_declaration: ["name"],
  interface_declaration: ["name"],
  local_function_statement: ["name"],
  method_declaration: ["name"],
  namespace_declaration: ["name"],
  property_declaration: ["name"],
  record_declaration: ["name"],
  struct_declaration: ["name"],
});

const C_DECLARATIONS = declarationFields({
  enum_specifier: ["name"],
  enumerator: ["name"],
  function_definition: ["declarator"],
  preproc_def: ["name"],
  preproc_function_def: ["name"],
  struct_specifier: ["name"],
  type_definition: ["declarator"],
  union_specifier: ["name"],
});

const CPP_DECLARATIONS = declarationFields({
  alias_declaration: ["name"],
  class_specifier: ["name"],
  concept_definition: ["name"],
  enum_specifier: ["name"],
  enumerator: ["name"],
  function_definition: ["declarator"],
  namespace_alias_definition: ["name"],
  namespace_definition: ["name"],
  preproc_def: ["name"],
  preproc_function_def: ["name"],
  struct_specifier: ["name"],
  type_definition: ["declarator"],
  union_specifier: ["name"],
});

const RUBY_DECLARATIONS = declarationFields({
  class: ["name"],
  method: ["name"],
  module: ["name"],
  singleton_method: ["name"],
});

const SHELL_DECLARATIONS = declarationFields({
  function_definition: ["name"],
  variable_assignment: ["name"],
});

const PHP_DECLARATIONS = declarationFields({
  class_declaration: ["name"],
  enum_case: ["name"],
  enum_declaration: ["name"],
  function_definition: ["name"],
  interface_declaration: ["name"],
  method_declaration: ["name"],
  namespace_definition: ["name"],
  property_element: ["name"],
  trait_declaration: ["name"],
});

const SCALA_DECLARATIONS = declarationFields({
  class_definition: ["name"],
  enum_definition: ["name"],
  full_enum_case: ["name"],
  function_declaration: ["name"],
  function_definition: ["name"],
  given_definition: ["name"],
  object_definition: ["name"],
  package_object: ["name"],
  simple_enum_case: ["name"],
  trait_definition: ["name"],
  type_definition: ["name"],
  val_declaration: ["name"],
  var_declaration: ["name"],
});

const KOTLIN_DECLARATIONS = declarationFields({});

const KOTLIN_DECLARATION_NAME_PATHS = declarationNamePaths({
  class_declaration: [["type_identifier"]],
  enum_entry: [["simple_identifier"]],
  function_declaration: [["simple_identifier"]],
  object_declaration: [["type_identifier"]],
  property_declaration: [["variable_declaration", "simple_identifier"]],
  type_alias: [["type_identifier"]],
});

/**
 * Tree-sitter adapter for one grammar and extension family.
 */
export class TreeSitterLanguageAdapter implements LanguageEvidenceAdapter {
  /**
   * Stable adapter and normalization identifier.
   */
  readonly id: string;

  /**
   * Lowercase source extensions supported by this adapter.
   */
  readonly extensions: readonly string[];

  /**
   * Initialized Tree-sitter parser.
   */
  private parserPromise?: Promise<Parser>;

  /**
   * Deferred native grammar loader.
   */
  private readonly loadLanguage: TreeSitterLanguageLoader;

  /**
   * Language-specific declaration nodes and logical-name fields.
   */
  private readonly declarations: DeclarationNameFields;

  /**
   * Named-child paths for declaration grammars without field metadata.
   */
  private readonly declarationNamePaths: DeclarationNamePaths;

  constructor(options: {
    /**
     * Stable adapter identifier included in persisted evidence versions.
     */
    id: string;

    /**
     * Lowercase source extensions supported by the grammar.
     */
    extensions: readonly string[];

    /**
     * Native Tree-sitter language object.
     */
    language?: TreeSitterLanguage;

    /**
     * Deferred native grammar loader used by built-in adapters.
     */
    loadLanguage?: TreeSitterLanguageLoader;

    /**
     * Language-specific declaration nodes and logical-name fields.
     *
     * @default JavaScript and TypeScript declaration rules.
     */
    declarations?: DeclarationNameFields;

    /**
     * Language-specific named-child paths used when a grammar omits fields.
     */
    declarationNamePaths?: DeclarationNamePaths;
  }) {
    const id = options.id.trim();
    if (!id) {
      throw new EvidenceResourceError("Language adapter id cannot be empty.");
    }
    if (options.extensions.length === 0) {
      throw new EvidenceResourceError(
        `Language adapter ${id} must register at least one extension.`,
      );
    }

    const extensions = options.extensions.map((extension) =>
      normalizeExtension(extension, id),
    );
    if (new Set(extensions).size !== extensions.length) {
      throw new EvidenceResourceError(
        `Language adapter ${id} cannot register duplicate extensions.`,
      );
    }
    if (
      (options.language === undefined) ===
      (options.loadLanguage === undefined)
    ) {
      throw new EvidenceResourceError(
        `Language adapter ${id} must configure exactly one grammar source.`,
      );
    }

    this.id = id;
    this.extensions = extensions;
    const language = options.language;
    this.loadLanguage =
      options.loadLanguage ??
      (() => {
        if (language === undefined) {
          throw new EvidenceParseError(
            `Language adapter ${id} has no grammar source.`,
          );
        }
        return language;
      });
    this.declarations = options.declarations ?? JAVASCRIPT_DECLARATIONS;
    this.declarationNamePaths = options.declarationNamePaths ?? new Map();
  }

  /**
   * Resolves a unique simple or dotted declaration name.
   *
   * @param input - Source path, content, and requested symbol.
   * @returns Resolved source and syntax serialization, or `null`.
   */
  async resolveSymbol(input: {
    /**
     * Repository-relative source path.
     */
    path: string;

    /**
     * Complete source text.
     */
    source: string;

    /**
     * Simple or dotted logical symbol name.
     */
    symbol: string;
  }): Promise<SymbolResolution | null> {
    if (input.source.includes("\0")) {
      throw new EvidenceParseError(
        `Tree-sitter cannot safely parse null bytes in ${input.path}`,
      );
    }
    const parser = await this.getParser();
    let tree: Parser.Tree;
    try {
      // node-tree-sitter reads JavaScript strings as UTF-16 and defaults its
      // native input buffer to 32 KiB. Its partial-string path throws EINVAL
      // once a source reaches that boundary, so size the buffer for the full
      // string plus the terminator instead of relying on the broken default.
      tree = parser.parse(input.source, undefined, {
        bufferSize: input.source.length + 1,
      });
    } catch (error) {
      throw new EvidenceParseError(
        `Tree-sitter failed to parse ${input.path}: ${toErrorMessage(error)}`,
      );
    }

    if (tree.rootNode.hasError) {
      throw new EvidenceParseError(
        `Tree-sitter produced a syntax error for ${input.path}`,
      );
    }

    const candidates = collectDeclarations(
      tree.rootNode,
      input.source,
      this.declarations,
      this.declarationNamePaths,
    );
    const exact = candidates.filter(
      (candidate) => candidate.qualifiedName === input.symbol,
    );
    const matches =
      exact.length > 0
        ? exact
        : candidates.filter((candidate) => candidate.name === input.symbol);

    if (matches.length !== 1) {
      return null;
    }

    const [match] = matches;
    return {
      content: input.source.slice(match.node.startIndex, match.node.endIndex),
      normalized: serializeSyntax(match.node, input.source),
    };
  }

  /**
   * Initializes and caches the parser for the first symbol lookup.
   *
   * @returns Parser configured with this adapter's native grammar.
   */
  private getParser(): Promise<Parser> {
    this.parserPromise ??= Promise.resolve()
      .then(() => this.loadLanguage())
      .then((language) => {
        const parser = new Parser();
        parser.setLanguage(language);
        return parser;
      })
      .catch((error: unknown) => {
        throw new EvidenceParseError(
          `Unable to initialize Tree-sitter adapter ${this.id}: ${toErrorMessage(error)}`,
        );
      });
    return this.parserPromise;
  }
}

/**
 * Internal logical declaration candidate.
 */
interface DeclarationCandidate {
  /**
   * Simple declaration name.
   */
  name: string;

  /**
   * Ancestor-qualified declaration name.
   */
  qualifiedName: string;

  /**
   * Syntax node whose complete contents establish the evidence.
   */
  node: Parser.SyntaxNode;
}

/**
 * Collects declaration candidates and dotted ancestor names.
 *
 * @param root - Parsed syntax-tree root.
 * @param source - Complete source text.
 * @param declarations - Language-specific declaration-name rules.
 * @param declarationNamePaths - Named-child paths for fieldless grammars.
 * @returns Stable source-order declaration candidates.
 */
function collectDeclarations(
  root: Parser.SyntaxNode,
  source: string,
  declarations: DeclarationNameFields,
  declarationNamePaths: DeclarationNamePaths,
): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];

  /**
   * Visits one syntax node and its declaration ancestry.
   *
   * @param node - Current syntax node.
   * @param ancestors - Logical containing declarations.
   */
  function visit(node: Parser.SyntaxNode, ancestors: readonly string[]): void {
    const nameNode = findDeclarationName(
      node,
      declarations,
      declarationNamePaths,
    );
    const name = nameNode
      ? normalizeLogicalName(
          source.slice(nameNode.startIndex, nameNode.endIndex),
        )
      : undefined;
    const nextAncestors = name ? [...ancestors, name] : ancestors;

    if (name) {
      candidates.push({
        name,
        qualifiedName: nextAncestors.join("."),
        node,
      });
    }

    for (const child of node.namedChildren) {
      visit(child, nextAncestors);
    }
  }

  visit(root, []);
  return candidates;
}

/**
 * Returns the logical name node for a supported declaration.
 *
 * @param node - Candidate syntax node.
 * @param declarations - Language-specific declaration-name rules.
 * @param declarationNamePaths - Named-child paths for fieldless grammars.
 * @returns Declaration name node, or `null` for non-declarations.
 */
function findDeclarationName(
  node: Parser.SyntaxNode,
  declarations: DeclarationNameFields,
  declarationNamePaths: DeclarationNamePaths,
): Parser.SyntaxNode | null {
  const fields = declarations.get(node.type);
  if (fields) {
    for (const field of fields) {
      const nameNode = findLogicalNameNode(node.childForFieldName(field));
      if (nameNode) {
        return nameNode;
      }
    }
  }

  const paths = declarationNamePaths.get(node.type);
  if (paths) {
    for (const path of paths) {
      const nameNode = findNamedChildPath(node, path);
      if (nameNode) {
        return nameNode;
      }
    }
  }
  return null;
}

/**
 * Follows a sequence of direct named-child node types to a declaration name.
 *
 * @param node - Declaration node at the start of the path.
 * @param path - Ordered direct named-child types.
 * @returns Logical declaration name node, or `null` when the path is absent.
 */
function findNamedChildPath(
  node: Parser.SyntaxNode,
  path: readonly string[],
): Parser.SyntaxNode | null {
  let current = node;
  for (const childType of path) {
    const child = current.namedChildren.find(
      (candidate) => candidate.type === childType,
    );
    if (!child) {
      return null;
    }
    current = child;
  }
  return findLogicalNameNode(current);
}

/**
 * Unwraps declarator nodes until their stable logical name is reached.
 *
 * C and C++ grammars nest names under pointer, function, array, and qualified
 * declarators. Other grammars generally return the final identifier directly,
 * so the same traversal safely handles both shapes.
 *
 * @param node - Name field or nested declarator node.
 * @returns Innermost logical name node, or `null` when absent.
 */
function findLogicalNameNode(
  node: Parser.SyntaxNode | null,
): Parser.SyntaxNode | null {
  if (!node) {
    return null;
  }
  if (
    node.type === "qualified_identifier" ||
    node.type === "scope_resolution"
  ) {
    return node;
  }

  const nestedName = node.childForFieldName("name");
  if (nestedName) {
    return findLogicalNameNode(nestedName);
  }
  const nestedDeclarator = node.childForFieldName("declarator");
  if (nestedDeclarator) {
    return findLogicalNameNode(nestedDeclarator);
  }
  return node;
}

/**
 * Canonicalizes common language-specific qualification separators.
 *
 * @param name - Exact source text of a declaration name.
 * @returns Dotted logical name used by repository evidence resources.
 */
function normalizeLogicalName(name: string): string {
  return name.replace(/::/gu, ".");
}

/**
 * Serializes syntax without whitespace trivia while retaining structure and tokens.
 *
 * @param node - Syntax node to serialize.
 * @param source - Complete source text used for leaf values.
 * @returns Stable structural representation.
 */
function serializeSyntax(node: Parser.SyntaxNode, source: string): string {
  if (node.childCount === 0) {
    return `${node.type}:${JSON.stringify(
      source.slice(node.startIndex, node.endIndex),
    )}`;
  }

  return `(${node.type}${node.children
    .map((child) => ` ${serializeSyntax(child, source)}`)
    .join("")})`;
}

/**
 * Converts an unknown thrown value into safe diagnostic text.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable message without inspecting external state.
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Canonicalizes and validates one adapter extension.
 *
 * @param extension - Configured source extension.
 * @param adapterId - Owning adapter identifier for diagnostics.
 * @returns Lowercase dot-prefixed extension.
 */
function normalizeExtension(extension: string, adapterId: string): string {
  const normalized = extension.trim().toLowerCase();
  if (!/^\.[a-z0-9]+$/u.test(normalized)) {
    throw new EvidenceResourceError(
      `Language adapter ${adapterId} has invalid extension: ${extension}`,
    );
  }
  return normalized;
}

/**
 * Converts a declaration configuration object into an immutable lookup.
 *
 * @param fields - Declaration node types and possible logical-name fields.
 * @returns Lookup consumed by a language adapter.
 */
function declarationFields(
  fields: Readonly<Record<string, readonly string[]>>,
): DeclarationNameFields {
  return new Map(Object.entries(fields));
}

/**
 * Converts declaration child paths into an immutable lookup.
 *
 * @param paths - Declaration node types and possible named-child paths.
 * @returns Lookup consumed by fieldless language grammars.
 */
function declarationNamePaths(
  paths: Readonly<Record<string, readonly (readonly string[])[]>>,
): DeclarationNamePaths {
  return new Map(Object.entries(paths));
}

/**
 * Extracts a native grammar from a CommonJS package's default export.
 *
 * @param module - Dynamically imported grammar module.
 * @param packageName - Package name used in diagnostics.
 * @returns Native Tree-sitter language object.
 */
function defaultLanguage(
  module: unknown,
  packageName: string,
): TreeSitterLanguage {
  return requireLanguage(
    requireProperty(module, "default", packageName),
    packageName,
  );
}

/**
 * Extracts one named grammar from a CommonJS package's default export.
 *
 * @param module - Dynamically imported multi-language grammar module.
 * @param languageName - Property containing the requested native grammar.
 * @param packageName - Package name used in diagnostics.
 * @returns Native Tree-sitter language object.
 */
function namedDefaultLanguage(
  module: unknown,
  languageName: string,
  packageName: string,
): TreeSitterLanguage {
  const defaultExport = requireProperty(module, "default", packageName);
  return requireLanguage(
    requireProperty(defaultExport, languageName, packageName),
    packageName,
  );
}

/**
 * Reads a required object property without trusting untyped native modules.
 *
 * @param value - Unknown module or export object.
 * @param property - Required property name.
 * @param packageName - Package name used in diagnostics.
 * @returns Unknown property value for subsequent validation.
 */
function requireProperty(
  value: unknown,
  property: string,
  packageName: string,
): unknown {
  if (typeof value !== "object" || value === null || !(property in value)) {
    throw new EvidenceResolutionError(
      `Tree-sitter package ${packageName} does not export ${property}.`,
    );
  }
  return (value as Record<string, unknown>)[property];
}

/**
 * Validates an untyped native grammar export.
 *
 * @param value - Candidate native grammar.
 * @param packageName - Package name used in diagnostics.
 * @returns Validated Tree-sitter language object.
 */
function requireLanguage(
  value: unknown,
  packageName: string,
): TreeSitterLanguage {
  if (typeof value !== "object" || value === null) {
    throw new EvidenceResolutionError(
      `Tree-sitter package ${packageName} did not provide a native grammar.`,
    );
  }
  return value;
}

/**
 * Creates the built-in repository language evidence adapters.
 *
 * @returns Adapter list used by the repository resolver.
 */
export function createBuiltInLanguageEvidenceAdapters(): LanguageEvidenceAdapter[] {
  return [
    new TreeSitterLanguageAdapter({
      id: "javascript-v1",
      extensions: [".js", ".jsx", ".mjs", ".cjs"],
      declarations: JAVASCRIPT_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(
          await import("tree-sitter-javascript"),
          "tree-sitter-javascript",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "typescript-v1",
      extensions: [".ts", ".mts", ".cts"],
      declarations: JAVASCRIPT_DECLARATIONS,
      loadLanguage: async () =>
        namedDefaultLanguage(
          await import("tree-sitter-typescript"),
          "typescript",
          "tree-sitter-typescript",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "tsx-v1",
      extensions: [".tsx"],
      declarations: JAVASCRIPT_DECLARATIONS,
      loadLanguage: async () =>
        namedDefaultLanguage(
          await import("tree-sitter-typescript"),
          "tsx",
          "tree-sitter-typescript",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "python-v1",
      extensions: [".py", ".pyi"],
      declarations: PYTHON_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(
          await import("tree-sitter-python"),
          "tree-sitter-python",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "go-v1",
      extensions: [".go"],
      declarations: GO_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-go"), "tree-sitter-go"),
    }),
    new TreeSitterLanguageAdapter({
      id: "rust-v1",
      extensions: [".rs"],
      declarations: RUST_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-rust"), "tree-sitter-rust"),
    }),
    new TreeSitterLanguageAdapter({
      id: "java-v1",
      extensions: [".java"],
      declarations: JAVA_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-java"), "tree-sitter-java"),
    }),
    new TreeSitterLanguageAdapter({
      id: "kotlin-v1",
      extensions: [".kt", ".kts"],
      declarations: KOTLIN_DECLARATIONS,
      declarationNamePaths: KOTLIN_DECLARATION_NAME_PATHS,
      loadLanguage: async () =>
        defaultLanguage(
          await import("tree-sitter-kotlin"),
          "tree-sitter-kotlin",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "c-sharp-v1",
      extensions: [".cs"],
      declarations: C_SHARP_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(
          await import("tree-sitter-c-sharp"),
          "tree-sitter-c-sharp",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "c-v1",
      extensions: [".c"],
      declarations: C_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-c"), "tree-sitter-c"),
    }),
    new TreeSitterLanguageAdapter({
      id: "cpp-v1",
      extensions: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
      declarations: CPP_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-cpp"), "tree-sitter-cpp"),
    }),
    new TreeSitterLanguageAdapter({
      id: "ruby-v1",
      extensions: [".rb", ".rake"],
      declarations: RUBY_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-ruby"), "tree-sitter-ruby"),
    }),
    new TreeSitterLanguageAdapter({
      id: "shell-v1",
      extensions: [".sh", ".bash"],
      declarations: SHELL_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-bash"), "tree-sitter-bash"),
    }),
    new TreeSitterLanguageAdapter({
      id: "php-v1",
      extensions: [".php"],
      declarations: PHP_DECLARATIONS,
      loadLanguage: async () =>
        namedDefaultLanguage(
          await import("tree-sitter-php"),
          "php",
          "tree-sitter-php",
        ),
    }),
    new TreeSitterLanguageAdapter({
      id: "scala-v1",
      extensions: [".scala", ".sc"],
      declarations: SCALA_DECLARATIONS,
      loadLanguage: async () =>
        defaultLanguage(await import("tree-sitter-scala"), "tree-sitter-scala"),
    }),
  ];
}
