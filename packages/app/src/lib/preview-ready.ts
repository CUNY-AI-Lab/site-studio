const PREVIEW_READY_TOKEN = /^\d+$/;

/**
 * Append a parent notification only to a successfully resolved preview page.
 * The opaque sandbox prevents the parent from inspecting the child document,
 * while an iframe `load` event also fires for browser-generated error pages.
 */
export async function addPreviewReadySignal(html: string, token: string | undefined): Promise<string> {
  if (!token || !PREVIEW_READY_TOKEN.test(token)) return html;

  const payload = JSON.stringify({ type: "site-studio-preview-ready", token });
  const signal = `<script>addEventListener("load",()=>parent.postMessage(${payload},"*"),{once:true})</script>`;
  const rewriter = new HTMLRewriter().onDocument({
    end(end) {
      end.append(signal, { html: true });
    }
  });
  return rewriter.transform(new Response(html)).text();
}
