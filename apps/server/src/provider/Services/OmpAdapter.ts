/**
 * Per-instance adapter contract for the Oh My Pi ACP provider.
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OmpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
