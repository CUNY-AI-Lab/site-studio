/** Minimal executor boundary used by pure Site Builder unit tests. */
import { toJSONSchema, type ZodType } from "zod";

export class DynamicWorkerExecutor {
  constructor(..._args: never[]) {}
}

export function createCodeTool() {
  return {};
}

type ToolDefinition = { outputSchema?: ZodType };
type JsonSchemaNode = {
  type?: string;
  const?: string | number | boolean | null;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
};

function renderSchema(schema: JsonSchemaNode): string {
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    return union.map((branch) => renderSchema(branch)).join(" | ");
  }
  if (schema.const !== undefined) {
    return JSON.stringify(schema.const);
  }
  if (schema.type === "array") {
    return `${renderSchema(schema.items || { type: "unknown" })}[]`;
  }
  if (schema.type === "object" && schema.properties) {
    const required = new Set(schema.required || []);
    const fields = Object.entries(schema.properties).map(([key, value]) =>
      `${key}${required.has(key) ? "" : "?"}: ${renderSchema(value)}`
    );
    return `{ ${fields.join("; ")} }`;
  }
  return schema.type || "unknown";
}

export function generateTypes(tools: Record<string, ToolDefinition>): string {
  return Object.entries(tools).map(([name, tool]) => {
    const typeName = name
      .split("_")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
    if (!tool.outputSchema) {
      return `type ${typeName}Output = unknown;`;
    }
    // SAFETY: Zod's JSON Schema output is a JSON-schema object; this local
    // renderer reads only the documented discriminant/property fields.
    const schema = toJSONSchema(tool.outputSchema) as JsonSchemaNode;
    return `type ${typeName}Output = ${renderSchema(schema)};`;
  }).join("\n");
}
