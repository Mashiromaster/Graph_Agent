/**
 * TypeSafe "System One" (Jev) decision client.
 *
 * Jev is NOT a chat model: it never generates free text. You give it a `state`
 * plus a set of named `questions`, and it returns one typed answer per question
 * with a probability distribution. Every question is evaluated against the same
 * state in a single parallel pass.
 *
 * Because of that it does NOT implement `ModelAdapter` — there is no
 * `content`/`toolCalls` to return, and forcing it into that shape would mean
 * inventing text it never produced. It is a separate interface, consumed by the
 * `jev` model kind rather than by AgentNode's tool loop.
 *
 * Three question types (`criteria` shape differs per type):
 *   - choice: criteria = {option: description}; answer picks one option label
 *   - noul:   criteria = {"true": desc, "false": desc}; answer is P(true) in 0..1
 *   - score:  criteria = [low, ..., high]; answer is an ordinal rubric position
 *
 * Probability vs confidence are DISTINCT values and must not be swapped:
 * `probabilities[x]` is the mass on option x, while `confidence` is a separate
 * statistic derived from the whole distribution. Upstream docs call this out
 * explicitly, so the parser keeps them apart and never derives one from the
 * other.
 */

import { assertFinitePositive, canonicalJson } from "@graph-agent/core";
import { FetchJSONTransport, InvalidModelResponse } from "./transport.js";
import type { JSONTransport } from "./transport.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";
const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_QUESTIONS = 255;
const STATE_MAX_BYTES = 256 * 1024;

export type JevQuestionType = "choice" | "noul" | "score";

/** Pick exactly one option. `criteria` maps option label → when it applies. */
export interface JevChoiceQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
}

/** Truth probability. `criteria` describes the true/false conditions. */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria?: Readonly<{ true: string; false: string }>;
}

/** Ordinal rating. `criteria` is an ordered rubric, lowest level first. */
export interface JevScoreQuestion {
  readonly type: "score";
  readonly instructions: string;
  readonly criteria: readonly string[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

/** One decision. Exactly one of choice/noul/score is set, per `type`. */
export interface JevAnswer {
  readonly type: JevQuestionType;
  /** Selected option label — `choice` only. */
  readonly choice: string | null;
  /** P(true) in 0..1 — `noul` only. Carries no separate confidence upstream. */
  readonly noul: number | null;
  /** Rubric position — `score` only. */
  readonly score: number | null;
  /** Mass per option/level. Distinct from `confidence`. */
  readonly probabilities: Readonly<Record<string, number>>;
  /** Distribution-derived statistic. NOT a probability. Absent for `noul`. */
  readonly confidence: number | null;
  /** Rubric index → text — `score` only. */
  readonly legend: Readonly<Record<string, string>> | null;
}

export interface JevDecision {
  /** Resolved model version, e.g. "jev-1.13.0". */
  readonly model: string;
  /** Keyed by the question ids that were sent. */
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Reject malformed question sets before spending a request. Fail-closed: an
 * unknown `type` or an empty criteria map is a caller bug, not something to
 * silently forward.
 */
export function assertJevQuestions(
  questions: Readonly<Record<string, JevQuestion>>,
): void {
  const record = asRecord(questions);
  if (record === null) {
    throw new TypeError("questions must be a plain object");
  }
  const ids = Object.keys(record);
  if (ids.length === 0) {
    throw new Error("questions must not be empty");
  }
  if (ids.length > MAX_QUESTIONS) {
    throw new RangeError(`questions must have at most ${MAX_QUESTIONS} entries`);
  }
  for (const id of ids) {
    const question = asRecord(record[id]);
    if (question === null) {
      throw new TypeError(`questions.${id} must be an object`);
    }
    const instructions = question["instructions"];
    if (typeof instructions !== "string" || instructions.trim().length === 0) {
      throw new Error(`questions.${id}.instructions must be a non-empty string`);
    }
    const type = question["type"];
    const criteria = question["criteria"];
    if (type === "choice") {
      const map = asRecord(criteria);
      if (map === null || Object.keys(map).length < 2) {
        throw new Error(`questions.${id}.criteria must map at least 2 options`);
      }
      if (Object.keys(map).length > MAX_QUESTIONS) {
        throw new RangeError(
          `questions.${id}.criteria must have at most ${MAX_QUESTIONS} options`,
        );
      }
      for (const option of Object.keys(map)) {
        if (typeof map[option] !== "string") {
          throw new TypeError(`questions.${id}.criteria.${option} must be a string`);
        }
      }
    } else if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2) {
        throw new Error(`questions.${id}.criteria must be an ordered array of >= 2 levels`);
      }
      for (const level of criteria) {
        if (typeof level !== "string") {
          throw new TypeError(`questions.${id}.criteria entries must be strings`);
        }
      }
    } else if (type === "noul") {
      // criteria is optional for noul; when present it must carry both keys.
      if (criteria !== undefined) {
        const map = asRecord(criteria);
        if (
          map === null ||
          typeof map["true"] !== "string" ||
          typeof map["false"] !== "string"
        ) {
          throw new Error(`questions.${id}.criteria must have string "true" and "false" keys`);
        }
      }
    } else {
      throw new Error(`questions.${id}.type must be one of choice, noul, score`);
    }
  }
}

function parseProbabilities(raw: unknown): Record<string, number> {
  const map = asRecord(raw);
  if (map === null) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const key of Object.keys(map)) {
    const value = map[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    }
  }
  return out;
}

function parseUnitInterval(raw: unknown, label: string): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new InvalidModelResponse(`Jev response ${label} must be a number in 0..1`);
  }
  return raw;
}

function parseAnswer(id: string, raw: unknown): JevAnswer {
  const answer = asRecord(raw);
  if (answer === null) {
    throw new InvalidModelResponse(`Jev response answers.${id} must be an object`);
  }
  const type = answer["type"];
  const probabilities = parseProbabilities(answer["probabilities"]);
  // `confidence` is a separate statistic, never inferred from probabilities.
  const rawConfidence = answer["confidence"];
  const confidence =
    rawConfidence === undefined || rawConfidence === null
      ? null
      : parseUnitInterval(rawConfidence, `answers.${id}.confidence`);

  if (type === "choice") {
    const choice = answer["choice"];
    if (typeof choice !== "string" || choice.length === 0) {
      throw new InvalidModelResponse(`Jev response answers.${id}.choice must be a string`);
    }
    return Object.freeze({
      type: "choice" as const,
      choice,
      noul: null,
      score: null,
      probabilities: Object.freeze(probabilities),
      confidence,
      legend: null,
    });
  }

  if (type === "noul") {
    return Object.freeze({
      type: "noul" as const,
      choice: null,
      noul: parseUnitInterval(answer["noul"], `answers.${id}.noul`),
      score: null,
      probabilities: Object.freeze(probabilities),
      confidence,
      legend: null,
    });
  }

  if (type === "score") {
    const score = answer["score"];
    if (typeof score !== "number" || !Number.isFinite(score)) {
      throw new InvalidModelResponse(`Jev response answers.${id}.score must be a number`);
    }
    const legendRaw = asRecord(answer["legend"]);
    const legend: Record<string, string> = {};
    for (const key of Object.keys(legendRaw ?? {})) {
      const value = legendRaw![key];
      if (typeof value === "string") {
        legend[key] = value;
      }
    }
    return Object.freeze({
      type: "score" as const,
      choice: null,
      noul: null,
      score,
      probabilities: Object.freeze(probabilities),
      confidence,
      legend: legendRaw === null ? null : Object.freeze(legend),
    });
  }

  throw new InvalidModelResponse(
    `Jev response answers.${id}.type must be one of choice, noul, score`,
  );
}

function coerceTokens(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/**
 * Client for `POST /v1/systemone`.
 *
 * Deliberately not a `ModelAdapter` (see the file header). Transport is
 * injectable so tests exercise request/response handling without network.
 */
export class JevDecisionClient {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly transport: JSONTransport;

  constructor(config: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    timeoutSeconds?: number;
    transport?: JSONTransport;
  } = {}) {
    this.model = (config.model ?? DEFAULT_MODEL).trim();
    if (this.model.length === 0) {
      throw new Error("model must be a non-empty string");
    }

    const apiKey = config.apiKey ?? process.env["TYPESAFE_API_KEY"];
    if (apiKey === undefined || apiKey === "") {
      throw new Error("apiKey is required (or set TYPESAFE_API_KEY)");
    }
    this.apiKey = apiKey;

    this.baseUrl = (config.baseUrl ?? process.env["TYPESAFE_API_BASE"] ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.timeoutSeconds = assertFinitePositive(
      config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
      "timeoutSeconds",
    );
    this.transport = config.transport ?? new FetchJSONTransport();
  }

  /**
   * Evaluate every question against one state.
   *
   * `state` may be a string or a structured object; structured fields give Jev
   * more to work with than a flattened blob, so objects are passed through
   * rather than stringified.
   */
  async decide(input: {
    state: string | Readonly<Record<string, unknown>>;
    questions: Readonly<Record<string, JevQuestion>>;
  }): Promise<JevDecision> {
    assertJevQuestions(input.questions);

    if (typeof input.state !== "string" && asRecord(input.state) === null) {
      throw new TypeError("state must be a string or a plain object");
    }
    const stateBytes = Buffer.byteLength(
      typeof input.state === "string" ? input.state : canonicalJson(input.state),
      "utf8",
    );
    if (stateBytes > STATE_MAX_BYTES) {
      throw new RangeError("state exceeds the maximum serialized size");
    }

    const raw = await this.transport.postJson({
      url: `${this.baseUrl}/systemone`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      payload: { model: this.model, state: input.state, questions: input.questions },
      timeoutSeconds: this.timeoutSeconds,
    });

    const root = asRecord(raw);
    const answersRaw = asRecord(root?.["answers"]);
    if (answersRaw === null) {
      throw new InvalidModelResponse("Jev response has no answers object");
    }
    // Every question asked must come back; a partial answer set would silently
    // leave a decision unmade.
    const answers: Record<string, JevAnswer> = {};
    for (const id of Object.keys(input.questions)) {
      if (!Object.prototype.hasOwnProperty.call(answersRaw, id)) {
        throw new InvalidModelResponse(`Jev response is missing answers.${id}`);
      }
      answers[id] = parseAnswer(id, answersRaw[id]);
    }

    const usage = asRecord(root?.["usage"]);
    const model = root?.["model"];
    return Object.freeze({
      model: typeof model === "string" && model.length > 0 ? model : this.model,
      answers: Object.freeze(answers),
      inputTokens: coerceTokens(usage?.["input_tokens"]),
      outputTokens: coerceTokens(usage?.["output_tokens"]),
    });
  }
}
