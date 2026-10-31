(call_expression function: (identifier) @name) @ref.call
(call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @name)) @ref.call
(new_expression constructor: (identifier) @name) @ref.call
(new_expression constructor: (member_expression object: (_) @receiver property: (property_identifier) @name)) @ref.call
(import_statement source: (string (string_fragment) @name)) @ref.import
(import_specifier name: (identifier) @name) @ref.import
(member_expression object: (_) @receiver property: (property_identifier) @name) @ref.ident
