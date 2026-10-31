(call function: (identifier) @name) @ref.call
(call function: (attribute object: (_) @receiver attribute: (identifier) @name)) @ref.call
(import_statement name: (dotted_name) @name) @ref.import
(import_statement name: (aliased_import name: (dotted_name) @name)) @ref.import
(import_from_statement name: (dotted_name) @name) @ref.import
(import_from_statement name: (aliased_import name: (dotted_name) @name)) @ref.import
(attribute object: (_) @receiver attribute: (identifier) @name) @ref.ident
