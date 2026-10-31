(class_declaration name: (_) @name) @def.class
(class name: (_) @name) @def.class
(method_definition name: (property_identifier) @name) @def.method
(function_declaration name: (identifier) @name) @def.function
(generator_function_declaration name: (identifier) @name) @def.function
(variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @def.function
(variable_declarator name: (identifier) @name) @def.variable
(field_definition property: (property_identifier) @name) @def.field
(formal_parameters (identifier) @name @def.variable)
