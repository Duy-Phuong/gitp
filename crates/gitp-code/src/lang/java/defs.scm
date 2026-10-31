(class_declaration name: (identifier) @name) @def.class
(interface_declaration name: (identifier) @name) @def.interface
(enum_declaration name: (identifier) @name) @def.enum
(record_declaration name: (identifier) @name) @def.class
(method_declaration name: (identifier) @name) @def.method
(constructor_declaration name: (identifier) @name) @def.method
(field_declaration declarator: (variable_declarator name: (identifier) @name)) @def.field
(local_variable_declaration declarator: (variable_declarator name: (identifier) @name)) @def.variable
(formal_parameter name: (identifier) @name) @def.variable
