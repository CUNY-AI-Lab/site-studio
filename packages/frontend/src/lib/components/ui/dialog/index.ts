import { Dialog as DialogPrimitive } from "bits-ui";

import Title from "./dialog-title.svelte";
import Footer from "./dialog-footer.svelte";
import Header from "./dialog-header.svelte";
import Content from "./dialog-content.svelte";
import Description from "./dialog-description.svelte";

const Root = DialogPrimitive.Root;

export {
	Root,
	Title,
	Footer,
	Header,
	Content,
	Description,
};
