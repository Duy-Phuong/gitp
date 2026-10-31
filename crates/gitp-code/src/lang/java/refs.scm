(method_invocation object: (_) @receiver name: (identifier) @name) @ref.call
(method_invocation name: (identifier) @name) @ref.call
(object_creation_expression type: (type_identifier) @name) @ref.call
(object_creation_expression type: (generic_type (type_identifier) @name)) @ref.call
(import_declaration (scoped_identifier) @name) @ref.import
(type_identifier) @name @ref.ident
(field_access object: (_) @receiver field: (identifier) @name) @ref.ident
