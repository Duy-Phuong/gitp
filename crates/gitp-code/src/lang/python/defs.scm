(class_definition name: (identifier) @name) @def.class
(function_definition name: (identifier) @name) @def.function
(module (expression_statement (assignment left: (identifier) @name) @def.variable))
(class_definition body: (block (expression_statement (assignment left: (identifier) @name) @def.field)))
(parameters (identifier) @name @def.variable)
(typed_parameter (identifier) @name @def.variable)
(default_parameter name: (identifier) @name @def.variable)
(typed_default_parameter name: (identifier) @name @def.variable)
