import { TEXT_CONVERSION_ADAPTERS } from '@octafuse/core/adapters/registry';
import {
	convertTextHttpResponse,
	convertTextRequest,
	TextProtocolError,
	textErrorPayload,
	type JsonObject,
	type TextProtocol,
} from '@octafuse/core/text-protocol';
import type { ProxyDispatchResult } from '../failover-dispatch';
import type { RouteResult } from '../model-router';
import type { RequestTimingAttempt, RequestTimingCollector } from '../request-timing';
import { EMPTY_USAGE } from '../proxy';
import { buildRouteRequestBody } from '../route-default-params';
import { finalizeRequestLogJson } from '../request-log-shared';
import {
	summarizeAnthropicToolsForLog,
	summarizeGeminiToolsForLog,
	summarizeOpenAiToolsForLog,
} from '../request-log-tools-summary';
import { dispatchOpenAiRoute, type OpenAiDispatchOptions } from './openai-driver';
import { dispatchAnthropicRoute } from './anthropic-driver';
import { dispatchGeminiRoute } from './gemini-driver';

export async function dispatchTextConversion(
	route: RouteResult,
	from: TextProtocol,
	body: JsonObject,
	stream: boolean,
	requestSignal?: AbortSignal,
	timing?: RequestTimingCollector | null,
	attempt?: RequestTimingAttempt,
	options?: OpenAiDispatchOptions
): Promise<ProxyDispatchResult> {
	const descriptor = TEXT_CONVERSION_ADAPTERS.find((adapter) => adapter.id === route.adapter);
	if (
		!descriptor ||
		descriptor.request.protocol !== from ||
		descriptor.upstream.protocol !== route.upstreamProtocol
	) {
		throw new Error(`Invalid text conversion adapter: ${route.adapter}`);
	}
	const to = descriptor.upstream.protocol;
	let wire: JsonObject;
	try {
		wire = convertTextRequest(from, to, body, stream);
		if (to === 'anthropic' && buildRouteRequestBody(route, wire).max_tokens == null)
			wire.max_tokens = 4096;
	} catch (error) {
		if (!(error instanceof TextProtocolError)) throw error;
		return {
			response: new Response(JSON.stringify(textErrorPayload(from, error.message, 400)), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			}),
			usagePromise: Promise.resolve({ ...EMPTY_USAGE }),
			upstreamRequestId: null,
			meta: { textConversionClientError: true },
		};
	}
	const result =
		to === 'openai'
			? await dispatchOpenAiRoute(route, wire, requestSignal, timing, attempt, options)
			: to === 'anthropic'
			? await dispatchAnthropicRoute(route, wire, requestSignal, timing, attempt, options)
			: await dispatchGeminiRoute(
					route,
					wire,
					stream ? 'streamGenerateContent' : 'generateContent',
					'',
					requestSignal,
					timing,
					attempt,
					options
			  );
	const converted = await convertTextHttpResponse(result.response, to, from, {
		model: typeof body.model === 'string' ? body.model : route.providerModelName,
		includeUsage:
			(body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true,
	});
	return {
		...result,
		response: converted.response,
		usagePromise: Promise.all([result.usagePromise, converted.completion]).then(([usage, error]) =>
			error ? { ...usage, stream_error: error } : usage
		),
	};
}

/** Native upstream parameters, with conversation content and tool definitions redacted. */
export function textConversionUpstreamBodyForLog(
	route: RouteResult,
	from: TextProtocol,
	body: JsonObject,
	stream: boolean
): string | null {
	const descriptor = TEXT_CONVERSION_ADAPTERS.find((adapter) => adapter.id === route.adapter);
	if (!descriptor) return null;
	try {
		const to = descriptor.upstream.protocol;
		const wire = buildRouteRequestBody(route, convertTextRequest(from, to, body, stream));
		if (to === 'anthropic' && wire.max_tokens == null) wire.max_tokens = 4096;
		const redacted: JsonObject = {
			...wire,
			model: route.providerModelName,
			_adapter: route.adapter,
		};
		for (const key of ['messages', 'contents', 'system', 'systemInstruction', 'system_instruction'])
			delete redacted[key];
		if (wire.tools) {
			delete redacted.tools;
			Object.assign(
				redacted,
				to === 'openai'
					? summarizeOpenAiToolsForLog(wire.tools)
					: to === 'anthropic'
					? summarizeAnthropicToolsForLog(wire.tools)
					: summarizeGeminiToolsForLog(wire.tools)
			);
		}
		return finalizeRequestLogJson(redacted);
	} catch (error) {
		return finalizeRequestLogJson({
			_adapter: route.adapter,
			_conversion_error: error instanceof Error ? error.message : 'Invalid request',
		});
	}
}
