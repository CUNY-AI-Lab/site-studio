import type { StorageFile } from "../types";

const MAX_PROJECT_CONTEXT_FILES = 120;

type TreeNode = {
  dirs: Record<string, TreeNode>;
  files: string[];
};

function buildTree(paths: string[]): string {
  const root: TreeNode = {
    dirs: {},
    files: []
  };

  for (const filePath of paths) {
    const parts = filePath.split("/");
    let current = root;

    parts.forEach((part, index) => {
      if (index === parts.length - 1) {
        current.files.push(part);
        return;
      }

      current.dirs[part] ||= { dirs: {}, files: [] };
      current = current.dirs[part];
    });
  }

  function lines(node: TreeNode, prefix = ""): string[] {
    const result: string[] = [];

    for (const key of Object.keys(node.dirs).sort()) {
      result.push(`${prefix}${key}/`);
      result.push(...lines(node.dirs[key], `${prefix}  `));
    }

    for (const fileName of node.files.sort()) {
      result.push(`${prefix}${fileName}`);
    }

    return result;
  }

  return lines(root).join("\n");
}

export function buildProjectContext(files: StorageFile[]): string {
  if (files.length === 0) {
    return "Current project files:\n(project is empty)";
  }

  const sortedFiles = [...files].sort((left, right) => left.path.localeCompare(right.path));
  const shownFiles = sortedFiles.slice(0, MAX_PROJECT_CONTEXT_FILES);
  const tree = buildTree(shownFiles.map((file) => file.path));
  const extraFileCount = sortedFiles.length - shownFiles.length;
  const uploadedDocuments = sortedFiles.filter((file) => {
    return !file.isText && (
      file.contentType === "application/pdf" ||
      file.path.toLowerCase().endsWith(".docx")
    );
  });

  const sections = [`Current project files:\n${tree}`];

  if (extraFileCount > 0) {
    sections.push(`${extraFileCount} additional files are present but omitted from this summary.`);
  }

  if (uploadedDocuments.length > 0) {
    sections.push(
      `Uploaded documents in the project: ${uploadedDocuments.map((file) => file.path).join(", ")}. `
      + `Use extract_document_text for supported documents before summarizing or rewriting their contents.`
    );
  }

  return sections.join("\n\n");
}
