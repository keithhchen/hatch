import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { PiModelAdapter, type PiModelAdapterOptions } from "./PiModelAdapter.js";

export interface KimiModelAdapterOptions extends Omit<PiModelAdapterOptions, "model"> {
	model?: string;
	region?: "cn" | "global";
}

export interface GeminiModelAdapterOptions extends Omit<PiModelAdapterOptions, "model"> {
	model?: string;
}

export interface DeepSeekModelAdapterOptions extends Omit<PiModelAdapterOptions, "model"> {
	model?: string;
}

export class KimiModelAdapter extends PiModelAdapter {
	constructor(options: KimiModelAdapterOptions) {
		const region = options.region ?? "cn";
		super(
			"kimi",
			region === "cn" ? moonshotaiCnProvider() : moonshotaiProvider(),
			{
				...options,
				model: options.model ?? "kimi-k2.6",
				reasoning: options.reasoning ?? "high",
				temperature: options.temperature ?? 1,
			},
		);
	}
}

export class GeminiModelAdapter extends PiModelAdapter {
	constructor(options: GeminiModelAdapterOptions) {
		super("gemini", googleProvider(), { ...options, model: options.model ?? "gemini-3.8-flash" });
	}
}

export class DeepSeekModelAdapter extends PiModelAdapter {
	constructor(options: DeepSeekModelAdapterOptions) {
		super("deepseek", deepseekProvider(), { ...options, model: options.model ?? "deepseek-v4-flash" });
	}
}
