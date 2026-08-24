import vm from "node:vm";

const entryUrl = process.argv[2];
if (!entryUrl) throw new Error("An entry module URL is required");

const context = vm.createContext({});
const loadedModules = new Map();

async function loadModule(url) {
  const existing = loadedModules.get(url);
  if (existing) return existing;

  const response = await fetch(url, {
    credentials: "omit",
    headers: { Origin: "null" }
  });
  if (!response.ok) {
    throw new Error(`Module fetch failed at ${url}: ${response.status}`);
  }
  if (response.headers.get("Access-Control-Allow-Origin") !== "*") {
    throw new Error(`Opaque-origin module CORS rejected ${url}`);
  }
  const module = new vm.SourceTextModule(await response.text(), {
    context,
    identifier: url
  });
  loadedModules.set(url, module);
  await module.link((specifier, referencingModule) =>
    loadModule(new URL(specifier, referencingModule.identifier).href)
  );
  return module;
}

const entryModule = await loadModule(entryUrl);
await entryModule.evaluate();
console.log(JSON.stringify({
  entryMarker: context.entryMarker,
  nestedMarker: context.nestedMarker
}));
