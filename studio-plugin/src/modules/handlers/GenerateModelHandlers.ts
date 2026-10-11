import Utils from "../Utils";
import Recording from "../Recording";

const GenerationService = game.GetService("GenerationService");
const HttpService = game.GetService("HttpService");
const ServerStorage = game.GetService("ServerStorage");
const Selection = game.GetService("Selection");

const { getInstancePath } = Utils;
const { beginRecording, finishRecording } = Recording;

const OUTPUT_FOLDER_NAME = "__LumenGeneratedModels";
const GENERATE_MODEL_MODERATION_RETRIES = 2;

type AssetImageInput = {
	kind: "asset";
	asset_id: number;
};

function fail(message: string) {
	return { success: false, error: message };
}

function contentFromAssetId(assetId: number): Content {
	return Content.fromUri(`rbxassetid://${assetId}`);
}

function imageToContent(image: unknown): Content {
	const payload = image as Partial<AssetImageInput>;
	if (payload.kind !== "asset" || !typeIs(payload.asset_id, "number") || payload.asset_id <= 0) {
		error("generate_model image input must be an asset-backed Roblox image ID", 0);
	}
	return contentFromAssetId(math.floor(payload.asset_id));
}

function outputFolder(): Folder | string {
	const existing = ServerStorage.FindFirstChild(OUTPUT_FOLDER_NAME);
	if (existing !== undefined) {
		if (existing.IsA("Folder")) return existing;
		return `game.ServerStorage.${OUTPUT_FOLDER_NAME} already exists and is not a Folder`;
	}

	const folder = new Instance("Folder");
	folder.Name = OUTPUT_FOLDER_NAME;
	folder.Parent = ServerStorage;
	return folder;
}

function sanitizeName(value: unknown): string {
	const raw = typeIs(value, "string") && value !== "" ? value : "GeneratedModel";
	let name = raw.gsub("[%c]", " ")[0];
	name = name.gsub("^%s+", "")[0].gsub("%s+$", "")[0];
	if (name === "") name = "GeneratedModel";
	if (name.size() > 80) name = name.sub(1, 80);
	return name;
}

function uniqueName(parent: Instance, baseName: string): string {
	if (parent.FindFirstChild(baseName) === undefined) return baseName;
	for (let i = 2; i <= 999; i++) {
		const candidate = `${baseName}_${i}`;
		if (parent.FindFirstChild(candidate) === undefined) return candidate;
	}
	return `${baseName}_${HttpService.GenerateGUID(false)}`;
}

function buildInputs(requestData: Record<string, unknown>): Record<string, unknown> {
	const inputs: Record<string, unknown> = {};
	const prompt = requestData.prompt;
	if (typeIs(prompt, "string") && prompt !== "") {
		inputs.TextPrompt = prompt;
	}

	const image = requestData.image;
	if (image !== undefined) {
		inputs.Image = imageToContent(image);
	}

	const size = requestData.size as { x?: number; y?: number; z?: number } | undefined;
	if (size !== undefined) {
		inputs.Size = new Vector3(size.x ?? 1, size.y ?? 1, size.z ?? 1);
	}

	const maxTriangles = requestData.max_triangles;
	if (typeIs(maxTriangles, "number")) {
		inputs.MaxTriangles = math.floor(maxTriangles);
	}

	const generateTextures = requestData.generate_textures;
	if (typeIs(generateTextures, "boolean")) {
		inputs.GenerateTextures = generateTextures;
	}

	return inputs;
}

function buildSchema(requestData: Record<string, unknown>): Record<string, unknown> {
	const schemaGroups = requestData.schema_groups as string[] | undefined;
	if (schemaGroups !== undefined) {
		return { SchemaDefinition: { Groups: schemaGroups } };
	}
	const schema = typeIs(requestData.schema, "string") && requestData.schema !== ""
		? requestData.schema
		: "Body1";
	return { PredefinedSchema: schema };
}

function isModerationFailure(value: unknown): boolean {
	return tostring(value).find("Moderation failed", 1, true)[0] !== undefined;
}

function generateModel(requestData: Record<string, unknown>) {
	const [inputOk, inputsOrError] = pcall(() => buildInputs(requestData));
	if (!inputOk) return fail(`Failed to prepare model input: ${tostring(inputsOrError)}`);

	const schema = buildSchema(requestData);
	const recordingId = beginRecording("Generate model");
	let createdModel: Model | undefined;
	let generateOk = false;
	let generateResult: unknown;

	for (let attempt = 0; attempt <= GENERATE_MODEL_MODERATION_RETRIES; attempt++) {
		const [ok, result] = pcall(() => {
			return GenerationService.GenerateModelAsync(inputsOrError as Record<string, unknown>, schema, {});
		});
		generateOk = ok;
		generateResult = result;
		if (ok || !isModerationFailure(result) || attempt === GENERATE_MODEL_MODERATION_RETRIES) {
			break;
		}
		task.wait(0.25);
	}

	if (!generateOk) {
		finishRecording(recordingId, false);
		if (isModerationFailure(generateResult)) {
			return fail("Moderation failed after 3 attempts.");
		}
		return fail(tostring(generateResult));
	}

	if (!typeIs(generateResult, "Instance") || !generateResult.IsA("Model")) {
		finishRecording(recordingId, false);
		return fail("GenerationService did not return a Model.");
	}

	createdModel = generateResult as Model;
	const folder = outputFolder();
	if (typeIs(folder, "string")) {
		createdModel.Destroy();
		finishRecording(recordingId, false);
		return fail(folder);
	}

	createdModel.Name = uniqueName(folder, sanitizeName(requestData.name));
	createdModel.Parent = folder;
	pcall(() => Selection.Set([createdModel as Instance]));
	finishRecording(recordingId, true);

	return {
		success: true,
		modelPath: getInstancePath(createdModel),
	};
}

export = {
	generateModel,
};
