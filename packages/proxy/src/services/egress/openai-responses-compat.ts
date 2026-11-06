type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Responses reasoning 项的 summary 是必填数组；部分客户端/上游省略空摘要。 */
function normalizeReasoningItem(item: unknown): unknown {
	if (!isJsonObject(item) || item.type !== 'reasoning' || item.summary != null) return item;
	return { ...item, summary: [] };
}

function normalizeReasoningItems(items: unknown): unknown {
	if (!Array.isArray(items)) return items;
	const normalized = items.map(normalizeReasoningItem);
	return normalized.some((item, index) => item !== items[index]) ? normalized : items;
}

/** 在合并路由参数之后修复工具轮回传的 reasoning 项，不修改客户端历史。 */
export function normalizeResponsesInputBody(body: JsonObject): JsonObject {
	const input = normalizeReasoningItems(body.input);
	return input === body.input ? body : { ...body, input };
}

function normalizeResponseOutput(body: JsonObject): JsonObject {
	const output = normalizeReasoningItems(body.output);
	return output === body.output ? body : { ...body, output };
}

/** 修复 JSON output、SSE item 和终态 response.output，保留加密推理及未知字段。 */
export function normalizeResponsesOutputPayload(payload: JsonObject): JsonObject {
	let normalized = normalizeResponseOutput(payload);
	const item = normalizeReasoningItem(payload.item);
	if (item !== payload.item) normalized = { ...normalized, item };
	if (isJsonObject(payload.response)) {
		const response = normalizeResponseOutput(payload.response);
		if (response !== payload.response) normalized = { ...normalized, response };
	}
	return normalized;
}
