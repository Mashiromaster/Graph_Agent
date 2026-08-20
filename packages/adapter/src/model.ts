import type { ModelRequest, ModelResponse } from "./model-types.js";

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export class ScriptedModel implements ModelAdapter {
  private readonly responses: readonly ModelResponse[];
  private index = 0;
  readonly requests: ModelRequest[] = [];

  constructor(responses: ModelResponse[]) {
    this.responses = [...responses];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.index >= this.responses.length) {
      throw new Error("ScriptedModel has no response remaining");
    }
    const response = this.responses[this.index]!;
    this.index += 1;
    return response;
  }
}
