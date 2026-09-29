import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNanProviderConfig, NAN_PROVIDER_ID } from "../lib/nan-provider.ts";

export default function registerNanProvider(pi: ExtensionAPI): void {
	pi.registerProvider(NAN_PROVIDER_ID, createNanProviderConfig());
}
