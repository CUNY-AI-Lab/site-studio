import { HTMLRewriter as NodeHTMLRewriter } from "htmlrewriter";

Object.defineProperty(globalThis, "HTMLRewriter", {
  configurable: true,
  value: NodeHTMLRewriter,
  writable: true,
});
